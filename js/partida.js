// ===========================================================
// GhostStackPoker — js/partida.js
// Lógica da Tela 2 (Mesa): placar em tempo real, painel de ação
// (Call/Raise/All-in/Fold), fichas visuais, e — a partir da Fase 4 —
// permissões de Host: Entregar Pote, Cobrar Antes, gerar novo código
// e transferência obrigatória de Host ao sair.
// ===========================================================

import { supabaseClient } from './supabase.js';
import { loadSession, saveSession, clearSession } from './session.js';
import { generateRoomCode } from './room-code.js';
import {
  initialChipCounts,
  chipValues,
  calculateStackTotal,
  formatMoney,
  addChipsFromAmount,
  removeChipsForAmount
} from './chips.js';


// ---------- 1. SESSÃO: quem sou eu e em qual sala eu estou ----------

const session = loadSession();

if (!session) {
  window.location.href = 'home.html';
  throw new Error('Sem sessão ativa — redirecionando para o lobby.');
}

const roomCode = session.roomCode;   // id interno e estável da sala (NUNCA muda)
const myPlayerId = session.playerId;
const myName = session.playerName;

// "isHost" pode mudar durante a partida (transferência de host), por
// isso é "let" e não "const" — e sempre que mudar, sincronizamos de
// volta pro sessionStorage com saveSession().
let isHost = session.isHost;


// ---------- 2. ESTADO ----------

let myChipCounts = { ...initialChipCounts };
let pendingBetChips = { preta: 0, azul: 0, vermelha: 0, verde: 0, branca: 0, amarela: 0 };
let currentBet = 0;
let potTotal = 0;
let hasFolded = false;
let currentCallAmount = 0;
let lastKnownChips = 1000;
let playersCache = [];
let realtimeChannel = null;

let joinCode = '------';     // código público (mostrado na tela, pode ser regenerado)
let anteCollected = false;   // controla se "Cobrar Antes" já foi usado nesta rodada
let allowKick = false;       // configurado pelo host em host-config.html
let selectedNewHostId = null; // usado no modal de transferência de host


// ---------- 3. FUNÇÕES DE RENDER (tudo que toca o DOM) ----------

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

// Mostra/esconde tudo que só o Host pode ver ou fazer. Chamada sempre
// que "isHost", "anteCollected" ou os dados do jogador mudarem.
function renderHostUI() {
  document.getElementById('btn-generate-code').classList.toggle('hidden', !isHost);
  document.getElementById('panel-give-pot').classList.toggle('hidden', !isHost);

  // "Cobrar Antes" some assim que é usado, e só volta depois que o
  // Host entrega o pote (o que encerra a rodada).
  const showAnteBtn = isHost && !anteCollected;
  document.getElementById('btn-force-ante').classList.toggle('hidden', !showAnteBtn);
}

function getMaxTableBet() {
  let max = 0;
  playersCache.forEach(function (p) {
    if (!p.folded && p.current_bet > max) max = p.current_bet;
  });
  return max;
}

function getMyStackTotal() {
  return calculateStackTotal(myChipCounts);
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
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Reconstrói toda a lista de jogadores na tela (placar) a partir do Supabase.
function renderLeaderboard(players) {
  const listEl = document.getElementById('players-list');
  const winnerSelect = document.getElementById('select-winner');

  listEl.innerHTML = '';
  winnerSelect.innerHTML = '<option value="">Selecionar jogador...</option>';

  players.forEach(function (p) {
    const isMe = p.id === myPlayerId;

    const card = document.createElement('div');
    card.className = 'player-card flex items-center justify-between px-4 py-3' +
      (p.folded ? ' is-folded' : '') +
      (isMe ? ' is-turn' : '');

    const statusText = p.folded ? 'desistiu' : (p.current_bet > 0 ? ('apostou ' + formatMoney(p.current_bet)) : 'aguardando');
    const statusClass = p.folded ? 'text-burgundy' : (p.current_bet > 0 ? 'text-gold/80' : 'text-cream/40');

    // Botão de expulsar: só aparece pro Host, nos jogadores QUE NÃO são
    // ele mesmo, e só se a sala permitir expulsão (definido no host-config).
    const showKick = isHost && allowKick && !isMe;
    const kickButtonHtml = showKick
      ? '<button class="btn-kick-player text-burgundy/70 text-[10px] font-body underline ml-2" data-player-id="' + p.id + '" data-player-name="' + escapeHtml(p.name) + '">expulsar</button>'
      : '';

    card.innerHTML =
      '<div class="flex items-center gap-2">' +
        '<span class="w-2 h-2 rounded-full ' + (isMe ? 'bg-gold' : (p.is_host ? 'bg-burgundy' : 'bg-cream/20')) + '"></span>' +
        '<span class="text-cream font-body font-medium text-sm">' + escapeHtml(p.name) + (isMe ? ' (você)' : '') + (p.is_host ? ' 👑' : '') + '</span>' +
      '</div>' +
      '<div class="flex items-center">' +
        '<div class="text-right">' +
          '<p class="text-cream font-display text-base leading-none">' + formatMoney(p.chips) + '</p>' +
          '<p class="' + statusClass + ' text-[11px] font-body">' + statusText + '</p>' +
        '</div>' +
        kickButtonHtml +
      '</div>';

    listEl.appendChild(card);

    // O próprio host não aparece como opção pra "herdar o pote" contra si mesmo — na
    // verdade ele pode sim ganhar rodadas, então mantemos todos no select do pote.
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name + (isMe ? ' (você)' : '');
    winnerSelect.appendChild(option);
  });

  // Liga o clique dos botões "expulsar" recém-criados.
  document.querySelectorAll('.btn-kick-player').forEach(function (btn) {
    btn.addEventListener('click', function () {
      handleKickPlayer(btn.dataset.playerId, btn.dataset.playerName);
    });
  });
}


// ---------- 4. NAVEGAÇÃO ENTRE OS PAINÉIS (Ações <-> Montar Aumento) ----------

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
  renderChipsUI();
}


// ---------- 5. CLIQUE NAS FICHAS (dentro do painel de aumento) ----------

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


// ---------- 6. CONFIRMAR O AUMENTO ----------

document.getElementById('btn-confirm-bet').addEventListener('click', async function () {
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

  lastKnownChips = newChips;
  currentBet = 0;
  pendingBetChips = { preta: 0, azul: 0, vermelha: 0, verde: 0, branca: 0, amarela: 0 };
  renderChipsUI();
  showActionsPanel();
});


// ---------- 7. COBRIR APOSTA (CALL) ----------

document.getElementById('btn-action-call').addEventListener('click', async function () {
  if (document.getElementById('btn-action-call').disabled) return;
  if (currentCallAmount <= 0) return;

  const amount = currentCallAmount;
  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  if (!me) return;

  removeChipsForAmount(myChipCounts, amount);

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

  lastKnownChips = newChips;
  renderChipsUI();
  renderActionPanel();
});


// ---------- 8. ALL-IN ----------

document.getElementById('btn-action-allin').addEventListener('click', async function () {
  if (document.getElementById('btn-action-allin').disabled) return;

  const me = playersCache.find(function (p) { return p.id === myPlayerId; });
  if (!me) return;

  const amount = getMyStackTotal();
  if (amount <= 0) return;

  for (const color in myChipCounts) myChipCounts[color] = 0;

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

  lastKnownChips = newChips;
  renderChipsUI();
  renderActionPanel();
});


// ---------- 9. DESISTIR (FOLD) ----------

document.getElementById('btn-action-fold').addEventListener('click', async function () {
  hasFolded = !hasFolded;

  const foldBtn = document.getElementById('btn-action-fold');
  foldBtn.querySelector('span').textContent = hasFolded ? 'Voltar pra rodada' : 'Desistir';

  await supabaseClient
    .from('players')
    .update({ folded: hasFolded })
    .eq('id', myPlayerId);
});


// ---------- 10. COBRAR ANTES (só o Host vê este botão) ----------

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


// ---------- 11. ENTREGAR POTE AO VENCEDOR (só o Host vê este painel) ----------

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

  // Encerra a rodada: zera o pote E libera "Cobrar Antes" de novo pra próxima.
  await supabaseClient
    .from('rooms')
    .update({ pot: 0, ante_collected: false })
    .eq('id', roomCode);

  hasFolded = false;
  document.getElementById('btn-action-fold').querySelector('span').textContent = 'Desistir';
  showActionsPanel();

  anteCollected = false;
  renderHostUI();
});


// ---------- 12. GERAR NOVO CÓDIGO (anti-troll, só o Host) ----------

document.getElementById('btn-generate-code').addEventListener('click', async function () {
  if (!isHost) return;

  const btn = document.getElementById('btn-generate-code');
  btn.textContent = 'gerando...';

  // O "id" da sala (roomCode) NUNCA muda — só trocamos o join_code
  // público. Assim quem já está na mesa nem percebe a troca.
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


// ---------- 13. EXPULSAR JOGADOR (só o Host, se a sala permitir) ----------

async function handleKickPlayer(playerId, playerName) {
  if (!isHost || !allowKick) return;
  const confirmed = confirm('Expulsar ' + playerName + ' da sala? Essa ação não pode ser desfeita.');
  if (!confirmed) return;

  await supabaseClient.from('players').delete().eq('id', playerId);
  // O placar de todo mundo (inclusive o da vítima, que será chutada pro
  // lobby) se atualiza sozinho via Realtime — ver refreshPlayers().
}


// ---------- 14. MODAL DE REGRAS ----------

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


// ---------- 15. SAIR DA SALA (com transferência de Host obrigatória) ----------

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
    // Ninguém pra herdar o cargo — sair encerra a sala pra todo mundo.
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
    // O Host não pode simplesmente sumir — precisa escolher um sucessor
    // (ou encerrar a sala, se estiver sozinho).
    event.preventDefault();
    openTransferModal();
  } else {
    // Jogador comum: sai livremente, sem restrição.
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    // deixa o navegador seguir o link normalmente até home.html
  }
});

btnConfirmTransfer.addEventListener('click', async function () {
  btnConfirmTransfer.disabled = true;
  btnConfirmTransfer.textContent = 'Saindo...';

  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  if (selectedNewHostId === null) {
    // Estava sozinho na sala: encerra tudo (apagar a sala cascade-deleta os jogadores).
    await supabaseClient.from('rooms').delete().eq('id', roomCode);
  } else {
    // Promove o escolhido e remove o host atual.
    await supabaseClient.from('players').update({ is_host: true }).eq('id', selectedNewHostId);
    await supabaseClient.from('rooms').update({ host_id: selectedNewHostId }).eq('id', roomCode);
    await supabaseClient.from('players').delete().eq('id', myPlayerId);
  }

  clearSession();
  window.location.href = 'home.html';
});


// ---------- 16. REALTIME: buscar jogadores/sala e ouvir mudanças ----------

async function refreshPlayers() {
  const { data, error } = await supabaseClient
    .from('players')
    .select('*')
    .eq('room_code', roomCode)
    .order('joined_at', { ascending: true });

  if (error || !data) return;

  const me = data.find(function (p) { return p.id === myPlayerId; });

  if (!me) {
    // Meu registro sumiu do banco — só acontece se o Host me expulsou.
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    alert('Você foi removido desta sala pelo host.');
    window.location.href = 'home.html';
    return;
  }

  playersCache = data;
  renderLeaderboard(data);

  // Detecta se acabei de virar Host (transferência de cargo em tempo real).
  if (me.is_host !== isHost) {
    isHost = me.is_host;
    saveSession({ roomCode: roomCode, playerId: myPlayerId, playerName: myName, isHost: isHost });
    renderHostUI();
  }

  if (me.chips !== lastKnownChips) {
    const delta = me.chips - lastKnownChips;
    if (delta > 0) addChipsFromAmount(myChipCounts, delta);
    else removeChipsForAmount(myChipCounts, -delta);
    lastKnownChips = me.chips;
    renderChipsUI();
  }

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

  renderRoomCodeUI();
  renderPotUI();
  renderHostUI();
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

        renderPotUI();
        renderRoomCodeUI();
        renderHostUI();
        renderLeaderboard(playersCache); // reflete allowKick (mostra/some os botões "expulsar")
      }
    )
    .subscribe();
}


// ---------- 17. INICIALIZAÇÃO DA PÁGINA ----------

renderChipsUI();
renderHostUI();
refreshRoomInfo();
subscribeToRoom();
refreshPlayers();
