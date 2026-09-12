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
import { computeSidePots } from './pots.js';
import { evaluateWinCondition, buildFinalResults } from './win-condition.js';

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

// ----- Condição de vitória (definida pelo Host em host-config.html) -----
let winCondition = 'elimination'; // 'elimination' ou 'round_limit'
let roundLimit = null;
let currentRound = 0;
let gameStatus = 'in_progress';   // 'in_progress' ou 'finished'
let startingChips = 1000;         // usado se algum dia o rebuy entrar em cena (Fase 3)

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
  listEl.innerHTML = '';

  players.forEach(function (p) {
    const isMe = p.id === myPlayerId;
    const isPlayersTurn = currentTurnSeat !== null && p.seat_number === currentTurnSeat;
    const isDealer = dealerSeat !== null && p.seat_number === dealerSeat;

    const card = document.createElement('div');
    card.className = 'player-card flex items-center justify-between px-4 py-3' +
      (p.folded ? ' is-folded' : '') +
      (isMe ? ' is-turn' : '') +
      (isPlayersTurn ? ' active-player-turn' : '');

    let statusText;
    let statusClass;
    if (p.is_eliminated) {
      statusText = 'eliminado';
      statusClass = 'text-burgundy';
    } else if (p.folded) {
      statusText = 'desistiu';
      statusClass = 'text-burgundy';
    } else if (p.current_bet > 0) {
      statusText = 'apostou ' + formatMoney(p.current_bet);
      statusClass = 'text-gold/80';
    } else {
      statusText = 'aguardando';
      statusClass = 'text-cream/40';
    }

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
        '<span class="text-cream font-body font-medium text-sm' + (p.is_eliminated ? ' opacity-40 line-through' : '') + '">' + escapeHtml(p.name) + (isMe ? ' (você)' : '') + (p.is_host ? ' 👑' : '') + '</span>' +
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
  });

  document.querySelectorAll('.btn-kick-player').forEach(function (btn) {
    btn.addEventListener('click', function () {
      handleKickPlayer(btn.dataset.playerId, btn.dataset.playerName);
    });
  });
}

// Monta o painel de "entregar pote" dinamicamente: se a mão teve algum
// all-in desproporcional, isso vira MAIS DE UM seletor (um por pote),
// cada um só com os jogadores elegíveis àquele pote específico. Quem
// desistiu nunca aparece em nenhuma lista (não pode ganhar).
function renderGivePotPanel() {
  const container = document.getElementById('give-pot-container');
  if (!isHost) {
    container.innerHTML = '';
    return;
  }

  const contributions = playersCache.map(function (p) {
    return { id: p.id, bet: p.current_bet, folded: p.folded };
  });
  const pots = computeSidePots(contributions);

  container.innerHTML = '';

  if (pots.length === 0) {
    container.innerHTML = '<p class="text-cream/40 text-xs font-body">Nenhuma aposta na mesa ainda — nada pra entregar.</p>';
    return;
  }

  pots.forEach(function (pot, index) {
    const eligiblePlayers = playersCache.filter(function (p) {
      return pot.eligible_player_ids.indexOf(p.id) !== -1;
    });

    const wrap = document.createElement('div');
    wrap.className = 'mb-3';

    const label = document.createElement('label');
    label.className = 'block text-cream/60 text-xs font-body mb-1';
    label.textContent = pots.length > 1
      ? ('Pote ' + (index + 1) + ' de ' + pots.length + ' — ' + formatMoney(pot.amount))
      : ('Vencedor da rodada — pote de ' + formatMoney(pot.amount));

    const select = document.createElement('select');
    select.className = 'pot-winner-select w-full bg-black/30 text-cream border border-gold/25 rounded-lg px-3 py-2.5 font-body outline-none focus:border-gold';
    select.dataset.potAmount = pot.amount;

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Selecionar jogador...';
    select.appendChild(defaultOption);

    eligiblePlayers.forEach(function (p) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name + (p.id === myPlayerId ? ' (você)' : '');
      select.appendChild(option);
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    container.appendChild(wrap);
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.id = 'btn-give-pot';
  confirmBtn.type = 'button';
  confirmBtn.className = 'w-full bg-gold text-ink font-body font-semibold py-2.5 rounded-lg text-sm mt-1';
  confirmBtn.textContent = pots.length > 1 ? 'Entregar todos os potes' : 'Entregar pote';
  confirmBtn.addEventListener('click', handleGivePotClick);
  container.appendChild(confirmBtn);
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
    // AUTO-WIN POR FOLD: se o meu fold deixou só 1 jogador ainda ativo
    // na mão (não desistiu e ainda tem fichas), ele ganha o pote INTEIRO
    // automaticamente — não faz sentido esperar side pot aqui, já que
    // não sobrou ninguém pra disputar nenhuma camada além dele.
    const projected = buildProjectedPlayers({ folded: true });
    const activeSeatsNow = getActiveSeats(projected);

    if (activeSeatsNow.length === 1 && potTotal > 0) {
      const winner = projected.find(function (p) { return p.seat_number === activeSeatsNow[0]; });
      if (winner) {
        await resolveEndOfHand([{ winnerId: winner.id, amount: potTotal }]);
        return;
      }
    }

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

// ---------- 11B. FIM DE MÃO (compartilhado entre "Entregar Pote" manual e Auto-Win por Fold) ----------
//
// "assignments" é uma lista de { winnerId, amount } — pode ter só 1 item
// (pote único, o caso mais comum) ou vários (quando teve side pot, cada
// pote pode ir pra uma pessoa diferente). Um mesmo jogador pode aparecer
// em mais de um assignment (ex: ganhou o principal E o secundário).
//
// Esta função NÃO é exclusiva do Host: o Auto-Win por Fold precisa poder
// chamá-la a partir de QUALQUER jogador (foi a própria desistência dele
// que encerrou a mão). O botão manual de "Entregar Pote" já só aparece
// pro Host via CSS (#panel-give-pot), então a permissão é controlada na
// interface, não aqui dentro.
async function resolveEndOfHand(assignments) {
  // 1) Soma quanto cada jogador ganhou (pode ganhar de mais de um pote).
  const gains = {};
  assignments.forEach(function (a) {
    gains[a.winnerId] = (gains[a.winnerId] || 0) + a.amount;
  });

  // 2) Aplica os ganhos a todo mundo e detecta quem ZEROU nesta mão
  // (fica marcado como eliminado, com o horário exato — usado no
  // ranking final do modo Mata-mata).
  const nowIso = new Date().toISOString();
  const updatedPlayers = playersCache.map(function (p) {
    const gain = gains[p.id] || 0;
    const newChips = p.chips + gain;
    const justEliminated = newChips <= 0 && !p.is_eliminated;

    return Object.assign({}, p, {
      chips: newChips,
      current_bet: 0,
      folded: false,
      is_eliminated: newChips <= 0 ? true : p.is_eliminated,
      eliminated_at: justEliminated ? nowIso : p.eliminated_at
    });
  });

  await Promise.all(updatedPlayers.map(function (p) {
    return supabaseClient
      .from('players')
      .update({
        chips: p.chips,
        current_bet: p.current_bet,
        folded: p.folded,
        is_eliminated: p.is_eliminated,
        eliminated_at: p.eliminated_at
      })
      .eq('id', p.id);
  }));

  // 3) Gira o Dealer e calcula quem age primeiro na PRÓXIMA mão (só
  // importa de verdade se o jogo for continuar).
  const occupiedSeats = getOccupiedSeats(playersCache);
  const newDealerSeat = computeNextDealerSeat(occupiedSeats, dealerSeat);
  const nextHandTurn = computeBlindSeats(occupiedSeats, newDealerSeat).firstToActSeat;

  // 4) Avalia a condição de vitória com os dados JÁ atualizados desta mão.
  const newRound = currentRound + 1;
  const winCheck = evaluateWinCondition(updatedPlayers, {
    win_condition: winCondition,
    round_limit: roundLimit,
    current_round: newRound
  });

  const roomUpdate = {
    pot: 0,
    ante_collected: false,
    side_pots: [],
    current_round: newRound
  };

  if (winCheck.finished) {
    roomUpdate.game_status = 'finished';
    roomUpdate.final_results = buildFinalResults(updatedPlayers, winCondition);
    roomUpdate.dealer_seat = null;
    roomUpdate.current_turn_seat = null;
  } else {
    roomUpdate.dealer_seat = newDealerSeat;
    roomUpdate.current_turn_seat = nextHandTurn;
  }

  await supabaseClient.from('rooms').update(roomUpdate).eq('id', roomCode);

  // 5) Atualiza o estado local (o Realtime também vai confirmar isso
  // pra todo mundo, mas atualizar aqui já deixa a resposta instantânea
  // pra quem clicou).
  playersCache = updatedPlayers;

  if (!winCheck.finished) {
    dealerSeat = newDealerSeat;
    currentTurnSeat = nextHandTurn;
  }

  hasFolded = false;
  document.getElementById('btn-action-fold').querySelector('span').textContent = 'Desistir';
  showActionsPanel();

  anteCollected = false;
  currentRound = newRound;
  renderHostUI();
  renderLeaderboard(playersCache);
  renderGivePotPanel();

  if (winCheck.finished) {
    gameStatus = 'finished';
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    window.location.href = 'lobby.html';
  }
}

// Lê os seletores montados por renderGivePotPanel() (1 por pote) e
// dispara resolveEndOfHand com todos os vencedores escolhidos de uma vez.
async function handleGivePotClick() {
  if (!isHost) return;

  const selects = document.querySelectorAll('.pot-winner-select');
  const assignments = [];

  for (const select of selects) {
    if (!select.value) {
      alert('Selecione um vencedor para cada pote antes de confirmar.');
      return;
    }
    assignments.push({ winnerId: select.value, amount: Number(select.dataset.potAmount) });
  }

  if (assignments.length === 0) return;

  const btn = document.getElementById('btn-give-pot');
  if (btn) { btn.disabled = true; btn.textContent = 'Entregando...'; }

  await resolveEndOfHand(assignments);
}

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
  renderGivePotPanel();

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
  winCondition = room.win_condition;
  roundLimit = room.round_limit;
  currentRound = room.current_round;
  gameStatus = room.game_status;
  startingChips = room.starting_chips;

  renderRoomCodeUI();
  renderPotUI();
  renderHostUI();
  renderLeaderboard(playersCache);
  renderGivePotPanel();
  renderActionPanel();

  // Se eu recarreguei a página (ou entrei) DEPOIS do jogo já ter
  // terminado, não faz sentido me mostrar a mesa — vai direto pro Lobby.
  redirectToLobbyIfFinished();
}

// Chamada tanto aqui quanto no listener do Realtime (subscribeToRoom) —
// cobre tanto "eu recarreguei a página depois do fim" quanto "o jogo
// terminou agora, enquanto eu estava com a mesa aberta".
function redirectToLobbyIfFinished() {
  if (gameStatus === 'finished') {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    window.location.href = 'lobby.html';
  }
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
        winCondition = payload.new.win_condition;
        roundLimit = payload.new.round_limit;
        currentRound = payload.new.current_round;
        gameStatus = payload.new.game_status;

        renderPotUI();
        renderRoomCodeUI();
        renderHostUI();
        renderLeaderboard(playersCache);
        renderGivePotPanel();
        renderActionPanel();

        redirectToLobbyIfFinished();
      }
    )
    .subscribe();
}

renderChipsUI();
renderHostUI();
refreshRoomInfo();
subscribeToRoom();
refreshPlayers();
