import { supabaseClient } from './supabase.js';
import { loadSession, saveSession, clearSession } from './session.js';
import { generateRoomCode } from './room-code.js';
import {
  initialChipCounts,
  chipValues,
  formatMoney,
  buildChipCountsForTotal
} from './chips.js';
import {
  getOccupiedSeats,
  getActiveSeats,
  getNextTurnSeat,
  computeNextDealerSeat,
  computeBlindSeats
} from './turn.js';

const session = loadSession();

if (!session) {
  window.location.href = 'home.html';
  throw new Error('Sem sessão ativa — redirecionando para o lobby.');
}

const roomCode = session.roomCode;
const myPlayerId = session.playerId;
const myName = session.playerName;

let isHost = session.isHost;

let myChipCounts = { ...initialChipCounts };
let pendingBetChips = { preta: 0, azul: 0, vermelha: 0, verde: 0, branca: 0, amarela: 0 };
let currentBet = 0;
let potTotal = 0;
let hasFolded = false;
let currentCallAmount = 0;
let playersCache = [];
let realtimeChannel = null;

let joinCode = '------';
let anteCollected = false;
let allowKick = false;
let selectedNewHostId = null;

let dealerSeat = null;
let currentTurnSeat = null;

function renderChipsUI() {
  for (const color in myChipCounts) {
    const counter = document.querySelector(`[data-count-for="${color}"]`);
    if (counter) counter.textContent = myChipCounts[color];

    const chipButton = document.querySelector(`.chip[data-chip-color="${color}"]`);
    if (chipButton) chipButton.disabled = myChipCounts[color] <= 0;
  }

  const currentBetEl = document.getElementById('current-bet');
  if (currentBetEl) currentBetEl.textContent = formatMoney(currentBet);
}

function renderPotUI() {
  const potEl = document.getElementById('pot-total');
  if (potEl) potEl.textContent = formatMoney(potTotal);
}

function renderRoomCodeUI() {
  document.getElementById('room-code-display').textContent = joinCode;
}

function getMySeatNumber() {
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  return me ? me.seat_number : null;
}

function isMyTurn() {
  const mySeat = getMySeatNumber();
  return mySeat !== null && mySeat !== undefined && mySeat === currentTurnSeat;
}

function getCurrentTurnPlayer() {
  return playersCache.find(function (p) { return p.seat_number === currentTurnSeat; }) || null;
}

function getFirstToActSeat() {
  const occupiedSeats = getOccupiedSeats(playersCache);
  return computeBlindSeats(occupiedSeats, dealerSeat).firstToActSeat;
}

function buildProjectedPlayers(overrides) {
  return playersCache.map(function (p) {
    if (p.id !== myPlayerId) return p;
    return Object.assign({}, p, overrides);
  });
}

async function advanceTurnAfterMyAction(overrides) {
  const mySeat = getMySeatNumber();
  if (mySeat === null || mySeat === undefined) return;

  const projected = buildProjectedPlayers(overrides);
  const occupiedSeats = getOccupiedSeats(projected);
  const activeSeats = getActiveSeats(projected);

  const nextSeat = getNextTurnSeat(occupiedSeats, activeSeats, mySeat);
  if (nextSeat === null) return;

  currentTurnSeat = nextSeat;
  renderLeaderboard(playersCache);
  renderActionPanel();
  renderHostUI();

  await supabaseClient.from('rooms').update({ current_turn_seat: nextSeat }).eq('id', roomCode);
}

function renderHostUI() {
  document.getElementById('btn-generate-code').classList.toggle('hidden', !isHost);
  document.getElementById('panel-give-pot').classList.toggle('hidden', !isHost);

  const handInProgress = currentTurnSeat !== null && currentTurnSeat !== undefined;

  document.getElementById('btn-start-hand').classList.toggle('hidden', !(isHost && !handInProgress));

  const isFirstTurnOfHand = handInProgress && currentTurnSeat === getFirstToActSeat();
  const showAnteBtn = isHost && !anteCollected && isFirstTurnOfHand;
  document.getElementById('btn-force-ante').classList.toggle('hidden', !showAnteBtn);
}

function getMaxTableBet() {
  let max = 0;
  playersCache.forEach(function (p) {
    if (!p.folded && p.current_bet > max) max = p.current_bet;
  });
  return max;
}

// FONTE DA VERDADE: sempre lê "chips" da última cópia do banco
// (playersCache), nunca da carteira visual (myChipCounts). Toda decisão
// de jogo (habilitar Call/Raise/All-in, valor do All-in, "Suas fichas")
// passa por aqui — assim nenhuma delas pode divergir do Supabase.
function getMyStackTotal() {
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  return me ? me.chips : 0;
}

function renderActionPanel() {
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  const myBet = me ? me.current_bet : 0;
  const maxBet = getMaxTableBet();
  const myStack = getMyStackTotal();

  currentCallAmount = Math.max(0, maxBet - myBet);

  document.getElementById('my-stack-display').textContent = formatMoney(myStack);
  document.getElementById('table-max-bet-display').textContent = formatMoney(maxBet);
  document.getElementById('call-amount-label').textContent =
    currentCallAmount > 0 ? formatMoney(currentCallAmount) : 'nada a cobrir';
  document.getElementById('allin-amount-label').textContent = formatMoney(myStack);

  const callBtn = document.getElementById('btn-action-call');
  const raiseBtn = document.getElementById('btn-action-raise');
  const allinBtn = document.getElementById('btn-action-allin');

  callBtn.disabled = myStack < currentCallAmount;
  raiseBtn.disabled = myStack <= currentCallAmount;
  allinBtn.disabled = myStack <= 0;

  const myTurn = isMyTurn();
  const grid = document.getElementById('action-buttons-grid');
  const statusLabel = document.getElementById('turn-status-label');
  const waitingMsg = document.getElementById('turn-waiting-message');
  const waitingName = document.getElementById('turn-waiting-name');

  grid.classList.toggle('hidden', !myTurn);
  statusLabel.classList.toggle('hidden', !myTurn);
  waitingMsg.classList.toggle('hidden', myTurn);

  if (!myTurn) {
    const turnPlayer = getCurrentTurnPlayer();
    waitingName.textContent = turnPlayer ? turnPlayer.name : 'outro jogador';

    const raisePanel = document.getElementById('panel-raise');
    if (!raisePanel.classList.contains('hidden')) {
      for (const color in pendingBetChips) {
        myChipCounts[color] += pendingBetChips[color];
        pendingBetChips[color] = 0;
      }
      currentBet = 0;
      renderChipsUI();
      showActionsPanel();
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderLeaderboard(players) {
  const listEl = document.getElementById('players-list');
  const winnerSelect = document.getElementById('select-winner');

  listEl.innerHTML = '';
  winnerSelect.innerHTML = '<option value="">Selecionar jogador...</option>';

  players.forEach(function (p) {
    const isMe = p.id === myPlayerId;
    const isPlayersTurn = currentTurnSeat !== null && p.seat_number === currentTurnSeat;
    const isDealer = dealerSeat !== null && p.seat_number === dealerSeat;

    const card = document.createElement('div');
    card.className = 'player-card flex items-center justify-between px-4 py-3' +
      (p.folded ? ' is-folded' : '') +
      (isMe ? ' is-turn' : '') +
      (isPlayersTurn ? ' active-player-turn' : '');

    const statusText = p.folded ? 'desistiu' : (p.current_bet > 0 ? ('apostou ' + formatMoney(p.current_bet)) : 'aguardando');
    const statusClass = p.folded ? 'text-burgundy' : (p.current_bet > 0 ? 'text-gold/80' : 'text-cream/40');

    const dealerBadgeHtml = isDealer ? '<span class="dealer-badge" title="Botão do Dealer">D</span>' : '';
    const turnBadgeHtml = isPlayersTurn
      ? '<span class="text-gold text-[10px] font-body font-semibold uppercase tracking-wide ml-1">● vez</span>'
      : '';

    const showKick = isHost && allowKick && !isMe;
    const kickButtonHtml = showKick
      ? '<button class="btn-kick-player" type="button" aria-label="Expulsar ' + escapeHtml(p.name) + '" title="Expulsar jogador" data-player-id="' + p.id + '" data-player-name="' + escapeHtml(p.name) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M16 17l5-5-5-5"/>' +
            '<path d="M21 12H9"/>' +
            '<path d="M13 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/>' +
          '</svg>' +
        '</button>'
      : '';

    card.innerHTML =
      '<div class="flex items-center gap-2">' +
        '<span class="w-2 h-2 rounded-full ' + (isMe ? 'bg-gold' : (p.is_host ? 'bg-burgundy' : 'bg-cream/20')) + '"></span>' +
        '<span class="text-cream font-body font-medium text-sm">' + escapeHtml(p.name) + (isMe ? ' (você)' : '') + (p.is_host ? ' 👑' : '') + '</span>' +
        dealerBadgeHtml +
        turnBadgeHtml +
      '</div>' +
      '<div class="flex items-center">' +
        '<div class="text-right">' +
          '<p class="text-cream font-display text-base leading-none">' + formatMoney(p.chips) + '</p>' +
          '<p class="' + statusClass + ' text-[11px] font-body">' + statusText + '</p>' +
        '</div>' +
        kickButtonHtml +
      '</div>';

    listEl.appendChild(card);

    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name + (isMe ? ' (você)' : '');
    winnerSelect.appendChild(option);
  });

  document.querySelectorAll('.btn-kick-player').forEach(function (btn) {
    btn.addEventListener('click', function () {
      handleKickPlayer(btn.dataset.playerId, btn.dataset.playerName);
    });
  });
}

function showActionsPanel() {
  document.getElementById('panel-raise').classList.add('hidden');
  document.getElementById('panel-raise').classList.remove('flex');
  document.getElementById('panel-actions').classList.remove('hidden');
  document.getElementById('panel-actions').classList.add('flex');
  renderActionPanel();
}

function showRaisePanel() {
  document.getElementById('panel-actions').classList.add('hidden');
  document.getElementById('panel-actions').classList.remove('flex');
  document.getElementById('panel-raise').classList.remove('hidden');
  document.getElementById('panel-raise').classList.add('flex');

  // Nunca confia na carteira visual de uma sessão anterior — reconstrói
  // do zero a partir do saldo real (me.chips) sempre que o jogador abre
  // o painel de fichas. Isso torna impossível "herdar" um valor errado.
  myChipCounts = buildChipCountsForTotal(getMyStackTotal());
  renderChipsUI();
}

document.querySelectorAll('.chip').forEach(function (chipButton) {
  chipButton.addEventListener('click', function () {
    const color = chipButton.dataset.chipColor;
    const value = Number(chipButton.dataset.chipValue);

    if (myChipCounts[color] <= 0) return;

    myChipCounts[color] -= 1;
    pendingBetChips[color] += 1;
    currentBet += value;

    renderChipsUI();
  });
});

document.getElementById('btn-clear-bet').addEventListener('click', function () {
  for (const color in pendingBetChips) {
    myChipCounts[color] += pendingBetChips[color];
    pendingBetChips[color] = 0;
  }
  currentBet = 0;
  renderChipsUI();
});

document.getElementById('btn-action-raise').addEventListener('click', function () {
  if (!isMyTurn()) return;
  if (document.getElementById('btn-action-raise').disabled) return;
  showRaisePanel();
});

document.getElementById('btn-raise-back').addEventListener('click', function () {
  for (const color in pendingBetChips) {
    myChipCounts[color] += pendingBetChips[color];
    pendingBetChips[color] = 0;
  }
  currentBet = 0;
  renderChipsUI();
  showActionsPanel();
});

document.getElementById('btn-confirm-bet').addEventListener('click', async function () {
  if (!isMyTurn()) return;
  if (currentBet <= 0) return;

  const betAmount = currentBet;
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  if (!me) return;

  const newChips = me.chips - betAmount;
  const newBet = me.current_bet + betAmount;

  const { error: playerError } = await supabaseClient
    .from('players')
    .update({ chips: newChips, current_bet: newBet })
    .eq('id', myPlayerId);

  if (playerError) {
    alert('Não foi possível confirmar o aumento: ' + playerError.message);
    return;
  }

  const { data: roomRow } = await supabaseClient
    .from('rooms').select('pot').eq('id', roomCode).single();

  await supabaseClient
    .from('rooms')
    .update({ pot: (roomRow ? roomRow.pot : potTotal) + betAmount })
    .eq('id', roomCode);

  currentBet = 0;
  pendingBetChips = { preta: 0, azul: 0, vermelha: 0, verde: 0, branca: 0, amarela: 0 };
  renderChipsUI();
  showActionsPanel();

  await advanceTurnAfterMyAction({ chips: newChips });
});

document.getElementById('btn-action-call').addEventListener('click', async function () {
  if (!isMyTurn()) return;
  if (document.getElementById('btn-action-call').disabled) return;
  if (currentCallAmount <= 0) return;

  const amount = currentCallAmount;
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  if (!me) return;

  const newChips = me.chips - amount;
  const newBet = me.current_bet + amount;

  await supabaseClient
    .from('players')
    .update({ chips: newChips, current_bet: newBet })
    .eq('id', myPlayerId);

  const { data: roomRow } = await supabaseClient
    .from('rooms').select('pot').eq('id', roomCode).single();

  await supabaseClient
    .from('rooms')
    .update({ pot: (roomRow ? roomRow.pot : potTotal) + amount })
    .eq('id', roomCode);

  renderActionPanel();

  await advanceTurnAfterMyAction({ chips: newChips });
});

document.getElementById('btn-action-allin').addEventListener('click', async function () {
  if (!isMyTurn()) return;
  if (document.getElementById('btn-action-allin').disabled) return;

  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  if (!me) return;

  // "amount" agora vem de getMyStackTotal(), que lê me.chips (o banco) —
  // não pode mais divergir do que o servidor considera meu saldo real.
  const amount = getMyStackTotal();
  if (amount <= 0) return;

  const newChips = me.chips - amount; // sempre 0, já que amount === me.chips

  const newBet = me.current_bet + amount;

  await supabaseClient
    .from('players')
    .update({ chips: newChips, current_bet: newBet })
    .eq('id', myPlayerId);

  const { data: roomRow } = await supabaseClient
    .from('rooms').select('pot').eq('id', roomCode).single();

  await supabaseClient
    .from('rooms')
    .update({ pot: (roomRow ? roomRow.pot : potTotal) + amount })
    .eq('id', roomCode);

  renderActionPanel();

  await advanceTurnAfterMyAction({ chips: newChips });
});

document.getElementById('btn-action-fold').addEventListener('click', async function () {
  if (!isMyTurn()) return;

  const wasFolded = hasFolded;
  hasFolded = !hasFolded;

  const foldBtn = document.getElementById('btn-action-fold');
  foldBtn.querySelector('span').textContent = hasFolded ? 'Voltar pra rodada' : 'Desistir';

  await supabaseClient
    .from('players')
    .update({ folded: hasFolded })
    .eq('id', myPlayerId);

  if (hasFolded && !wasFolded) {
    await advanceTurnAfterMyAction({ folded: true });
  }
});

document.getElementById('btn-start-hand').addEventListener('click', async function () {
  if (!isHost) return;

  const occupiedSeats = getOccupiedSeats(playersCache);
  if (occupiedSeats.length === 0) return;

  const newDealerSeat = computeNextDealerSeat(occupiedSeats, dealerSeat);
  const firstToActSeat = computeBlindSeats(occupiedSeats, newDealerSeat).firstToActSeat;

  const btn = document.getElementById('btn-start-hand');
  btn.disabled = true;
  btn.textContent = 'Iniciando...';

  await supabaseClient
    .from('rooms')
    .update({ dealer_seat: newDealerSeat, current_turn_seat: firstToActSeat })
    .eq('id', roomCode);

  dealerSeat = newDealerSeat;
  currentTurnSeat = firstToActSeat;

  btn.disabled = false;
  btn.textContent = 'Iniciar Mão';

  renderHostUI();
  renderLeaderboard(playersCache);
  renderActionPanel();
});

document.getElementById('btn-force-ante').addEventListener('click', async function () {
  if (!isHost) return;

  const { data: roomRow } = await supabaseClient
    .from('rooms').select('pot, ante_amount').eq('id', roomCode).single();

  if (!roomRow) return;
  const anteAmount = roomRow.ante_amount;

  const activePlayers = playersCache.filter(function (p) { return !p.folded; });

  await Promise.all(activePlayers.map(function (p) {
    return supabaseClient
      .from('players')
      .update({ chips: p.chips - anteAmount, current_bet: p.current_bet + anteAmount })
      .eq('id', p.id);
  }));

  await supabaseClient
    .from('rooms')
    .update({
      pot: roomRow.pot + (anteAmount * activePlayers.length),
      ante_collected: true
    })
    .eq('id', roomCode);

  anteCollected = true;
  renderHostUI();
});

document.getElementById('btn-give-pot').addEventListener('click', async function () {
  if (!isHost) return;

  const select = document.getElementById('select-winner');
  const winnerId = select.value;
  if (!winnerId) {
    alert('Selecione um jogador antes de entregar o pote.');
    return;
  }

  const { data: roomRow } = await supabaseClient
    .from('rooms').select('pot').eq('id', roomCode).single();
  const potAmount = roomRow ? roomRow.pot : potTotal;

  const winner = playersCache.find(function (p) { return p.id === winnerId; });
  if (!winner) return;

  await supabaseClient
    .from('players')
    .update({ chips: winner.chips + potAmount })
    .eq('id', winnerId);

  await Promise.all(playersCache.map(function (p) {
    return supabaseClient
      .from('players')
      .update({ current_bet: 0, folded: false })
      .eq('id', p.id);
  }));

  const occupiedSeats = getOccupiedSeats(playersCache);
  const newDealerSeat = computeNextDealerSeat(occupiedSeats, dealerSeat);
  const nextHandTurn = computeBlindSeats(occupiedSeats, newDealerSeat).firstToActSeat;

  await supabaseClient
    .from('rooms')
    .update({
      pot: 0,
      ante_collected: false,
      dealer_seat: newDealerSeat,
      current_turn_seat: nextHandTurn
    })
    .eq('id', roomCode);

  dealerSeat = newDealerSeat;
  currentTurnSeat = nextHandTurn;

  hasFolded = false;
  document.getElementById('btn-action-fold').querySelector('span').textContent = 'Desistir';
  showActionsPanel();

  anteCollected = false;
  renderHostUI();
  renderLeaderboard(playersCache);
});

document.getElementById('btn-generate-code').addEventListener('click', async function () {
  if (!isHost) return;

  const btn = document.getElementById('btn-generate-code');
  btn.textContent = 'gerando...';

  let success = false;
  let attempts = 0;

  while (!success && attempts < 5) {
    const candidate = generateRoomCode();
    const { error } = await supabaseClient
      .from('rooms')
      .update({ join_code: candidate })
      .eq('id', roomCode);

    if (!error) {
      success = true;
      joinCode = candidate;
      renderRoomCodeUI();
    }
    attempts++;
  }

  btn.textContent = 'novo código';
  if (!success) alert('Não foi possível gerar um novo código agora. Tente de novo em alguns segundos.');
});

async function handleKickPlayer(playerId, playerName) {
  if (!isHost || !allowKick) return;
  const confirmed = confirm('Expulsar ' + playerName + ' da sala? Essa ação não pode ser desfeita.');
  if (!confirmed) return;

  const kickedPlayer = playersCache.find(function (p) { return p.id === playerId; });

  await supabaseClient.from('players').delete().eq('id', playerId);

  if (kickedPlayer && kickedPlayer.seat_number === currentTurnSeat) {
    const remaining = playersCache.filter(function (p) { return p.id !== playerId; });
    const occupiedSeats = getOccupiedSeats(remaining);
    const activeSeats = getActiveSeats(remaining);
    const nextSeat = getNextTurnSeat(occupiedSeats, activeSeats, kickedPlayer.seat_number);

    if (nextSeat !== null) {
      currentTurnSeat = nextSeat;
      await supabaseClient.from('rooms').update({ current_turn_seat: nextSeat }).eq('id', roomCode);
    }
  }
}

const rulesModal = document.getElementById('modal-rules');

function openRulesModal() {
  rulesModal.classList.remove('hidden');
  rulesModal.classList.add('flex');
}

function closeRulesModal() {
  rulesModal.classList.add('hidden');
  rulesModal.classList.remove('flex');
}

document.getElementById('btn-rules-fab').addEventListener('click', openRulesModal);
document.getElementById('btn-close-rules').addEventListener('click', closeRulesModal);

rulesModal.addEventListener('click', function (event) {
  if (event.target === rulesModal) closeRulesModal();
});

const transferModal = document.getElementById('modal-transfer-host');
const transferList = document.getElementById('transfer-host-list');
const transferIntro = document.getElementById('transfer-host-intro');
const btnConfirmTransfer = document.getElementById('btn-confirm-transfer');

function openTransferModal() {
  selectedNewHostId = null;
  btnConfirmTransfer.disabled = true;
  btnConfirmTransfer.textContent = 'Confirmar e sair';

  const others = playersCache.filter(function (p) { return p.id !== myPlayerId; });

  if (others.length === 0) {
    transferIntro.textContent = 'Você é o único jogador na mesa. Sair vai encerrar a sala.';
    transferList.innerHTML = '';
    btnConfirmTransfer.disabled = false;
    btnConfirmTransfer.textContent = 'Encerrar sala e sair';
  } else {
    transferIntro.textContent = 'Escolha quem vai assumir como Host da mesa.';
    transferList.innerHTML = '';
    others.forEach(function (p) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'player-card flex items-center justify-between px-4 py-3 w-full text-left transfer-host-option';
      item.dataset.playerId = p.id;
      item.innerHTML =
        '<span class="text-cream font-body font-medium text-sm">' + escapeHtml(p.name) + '</span>' +
        '<span class="text-cream/40 text-xs font-body">' + formatMoney(p.chips) + '</span>';

      item.addEventListener('click', function () {
        selectedNewHostId = p.id;
        btnConfirmTransfer.disabled = false;
        document.querySelectorAll('.transfer-host-option').forEach(function (el) {
          el.classList.remove('is-turn');
        });
        item.classList.add('is-turn');
      });

      transferList.appendChild(item);
    });
  }

  transferModal.classList.remove('hidden');
  transferModal.classList.add('flex');
}

function closeTransferModal() {
  transferModal.classList.add('hidden');
  transferModal.classList.remove('flex');
}

document.getElementById('btn-cancel-transfer').addEventListener('click', closeTransferModal);

document.getElementById('link-leave-room').addEventListener('click', function (event) {
  if (isHost) {
    event.preventDefault();
    openTransferModal();
  } else {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
  }
});

btnConfirmTransfer.addEventListener('click', async function () {
  btnConfirmTransfer.disabled = true;
  btnConfirmTransfer.textContent = 'Saindo...';

  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  if (selectedNewHostId === null) {
    await supabaseClient.from('rooms').delete().eq('id', roomCode);
  } else {
    await supabaseClient.from('players').update({ is_host: true }).eq('id', selectedNewHostId);
    await supabaseClient.from('rooms').update({ host_id: selectedNewHostId }).eq('id', roomCode);
    await supabaseClient.from('players').delete().eq('id', myPlayerId);
  }

  clearSession();
  window.location.href = 'home.html';
});

async function refreshPlayers() {
  const { data, error } = await supabaseClient
    .from('players')
    .select('*')
    .eq('room_code', roomCode)
    .order('joined_at', { ascending: true });

  if (error || !data) return;

  const me = data.find(function (p) { return p.id === myPlayerId; });

  if (!me) {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    alert('Você foi removido desta sala pelo host.');
    window.location.href = 'home.html';
    return;
  }

  playersCache = data;
  renderLeaderboard(data);

  if (me.is_host !== isHost) {
    isHost = me.is_host;
    saveSession({ roomCode: roomCode, playerId: myPlayerId, playerName: myName, isHost: isHost });
    renderHostUI();
  }

  // Não existe mais nenhum "ajuste incremental" da carteira visual aqui.
  // getMyStackTotal() já lê "me.chips" direto de playersCache (atualizado
  // 2 linhas acima), então "Suas fichas" e as regras de Call/Raise/All-in
  // ficam automaticamente corretas — sem depender de myChipCounts.
  // myChipCounts só é reconstruída quando o painel de fichas abre
  // (showRaisePanel), que é a única hora em que ela é exibida.

  hasFolded = me.folded;
  const foldBtn = document.getElementById('btn-action-fold');
  foldBtn.querySelector('span').textContent = hasFolded ? 'Voltar pra rodada' : 'Desistir';
  document.querySelectorAll('.chip').forEach(function (c) {
    c.disabled = hasFolded || myChipCounts[c.dataset.chipColor] <= 0;
  });

  renderActionPanel();
}

async function refreshRoomInfo() {
  const { data: room, error } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('id', roomCode)
    .single();

  if (error || !room) return;

  joinCode = room.join_code;
  potTotal = room.pot;
  anteCollected = room.ante_collected;
  allowKick = room.allow_kick;
  dealerSeat = room.dealer_seat;
  currentTurnSeat = room.current_turn_seat;

  renderRoomCodeUI();
  renderPotUI();
  renderHostUI();
  renderLeaderboard(playersCache);
  renderActionPanel();
}

function subscribeToRoom() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  realtimeChannel = supabaseClient
    .channel('room-' + roomCode)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: 'room_code=eq.' + roomCode },
      function () { refreshPlayers(); }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'id=eq.' + roomCode },
      function (payload) {
        potTotal = payload.new.pot;
        joinCode = payload.new.join_code;
        anteCollected = payload.new.ante_collected;
        allowKick = payload.new.allow_kick;
        dealerSeat = payload.new.dealer_seat;
        currentTurnSeat = payload.new.current_turn_seat;

        renderPotUI();
        renderRoomCodeUI();
        renderHostUI();
        renderLeaderboard(playersCache);
        renderActionPanel();
      }
    )
    .subscribe();
}

renderChipsUI();
renderHostUI();
refreshRoomInfo();
subscribeToRoom();
refreshPlayers();
