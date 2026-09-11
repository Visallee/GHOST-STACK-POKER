// ===========================================================
// GhostStackPoker — js/partida.js
// Lógica da Tela 2 (Mesa): placar em tempo real, painel de ação
// (Call/Raise/All-in/Fold), fichas visuais, ante e entrega do pote.
// ===========================================================

import { supabaseClient } from "./supabase.js";
import { loadSession, clearSession } from "./session.js";
import {
  initialChipCounts,
  chipValues,
  calculateStackTotal,
  formatMoney,
  addChipsFromAmount,
  removeChipsForAmount,
} from "./chips.js";

// ---------- 1. SESSÃO: quem sou eu e em qual sala eu estou ----------

const session = loadSession();

if (!session) {
  // Ninguém pode abrir a mesa sem antes ter criado/entrado numa sala no lobby.
  window.location.href = "home.html";
  throw new Error("Sem sessão ativa — redirecionando para o lobby.");
}

const roomCode = session.roomCode;
const myPlayerId = session.playerId;
const myName = session.playerName;
const isHost = session.isHost;

// ---------- 2. ESTADO ----------

let myChipCounts = { ...initialChipCounts };
let pendingBetChips = {
  preta: 0,
  azul: 0,
  vermelha: 0,
  verde: 0,
  branca: 0,
  amarela: 0,
};
let currentBet = 0; // valor sendo montado no painel de aumento (ainda não confirmado)
let potTotal = 0;
let hasFolded = false;
let currentCallAmount = 0; // recalculado sempre que o placar atualiza
let lastKnownChips = 1000; // último valor de "chips" que sei que está no banco pra mim
let playersCache = []; // cópia local da lista de jogadores da sala
let realtimeChannel = null;

// ---------- 3. FUNÇÕES DE RENDER (tudo que toca o DOM) ----------

function renderChipsUI() {
  for (const color in myChipCounts) {
    const counter = document.querySelector(`[data-count-for="${color}"]`);
    if (counter) counter.textContent = myChipCounts[color];

    const chipButton = document.querySelector(
      `.chip[data-chip-color="${color}"]`,
    );
    if (chipButton) chipButton.disabled = myChipCounts[color] <= 0;
  }

  const currentBetEl = document.getElementById("current-bet");
  if (currentBetEl) currentBetEl.textContent = formatMoney(currentBet);
}

function renderPotUI() {
  const potEl = document.getElementById("pot-total");
  if (potEl) potEl.textContent = formatMoney(potTotal);
}

// Maior valor apostado nesta rodada entre jogadores que ainda estão na mão.
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

// Atualiza os textos e o estado (habilitado/desabilitado) dos 4 botões de ação.
function renderActionPanel() {
  const me = playersCache.find(function (p) {
    return p.id === myPlayerId;
  });
  const myBet = me ? me.current_bet : 0;
  const maxBet = getMaxTableBet();
  const myStack = getMyStackTotal();

  currentCallAmount = Math.max(0, maxBet - myBet);

  document.getElementById("my-stack-display").textContent =
    formatMoney(myStack);
  document.getElementById("table-max-bet-display").textContent =
    formatMoney(maxBet);
  document.getElementById("call-amount-label").textContent =
    currentCallAmount > 0 ? formatMoney(currentCallAmount) : "nada a cobrir";
  document.getElementById("allin-amount-label").textContent =
    formatMoney(myStack);

  const callBtn = document.getElementById("btn-action-call");
  const raiseBtn = document.getElementById("btn-action-raise");
  const allinBtn = document.getElementById("btn-action-allin");

  // Call: desabilita se eu não tiver fichas suficientes pra cobrir.
  callBtn.disabled = myStack < currentCallAmount;

  // Raise: só faz sentido se eu tiver fichas além do que já cobriria o call.
  raiseBtn.disabled = myStack <= currentCallAmount;

  // All-in: SEMPRE disponível, só desabilita de fato se eu já estiver zerado.
  allinBtn.disabled = myStack <= 0;
}

// Evita que nomes de jogadores quebrem o HTML se tiverem símbolos.
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Reconstrói toda a lista de jogadores na tela (placar) a partir do Supabase.
function renderLeaderboard(players) {
  const listEl = document.getElementById("players-list");
  const winnerSelect = document.getElementById("select-winner");

  listEl.innerHTML = "";
  winnerSelect.innerHTML = '<option value="">Selecionar jogador...</option>';

  players.forEach(function (p) {
    const isMe = p.id === myPlayerId;

    const card = document.createElement("div");
    card.className =
      "player-card flex items-center justify-between px-4 py-3" +
      (p.folded ? " is-folded" : "") +
      (isMe ? " is-turn" : "");

    const statusText = p.folded
      ? "desistiu"
      : p.current_bet > 0
        ? "apostou " + formatMoney(p.current_bet)
        : "aguardando";
    const statusClass = p.folded
      ? "text-burgundy"
      : p.current_bet > 0
        ? "text-gold/80"
        : "text-cream/40";

    card.innerHTML =
      '<div class="flex items-center gap-2">' +
      '<span class="w-2 h-2 rounded-full ' +
      (isMe ? "bg-gold" : "bg-cream/20") +
      '"></span>' +
      '<span class="text-cream font-body font-medium text-sm">' +
      escapeHtml(p.name) +
      (isMe ? " (você)" : "") +
      "</span>" +
      "</div>" +
      '<div class="text-right">' +
      '<p class="text-cream font-display text-base leading-none">' +
      formatMoney(p.chips) +
      "</p>" +
      '<p class="' +
      statusClass +
      ' text-[11px] font-body">' +
      statusText +
      "</p>" +
      "</div>";

    listEl.appendChild(card);

    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = p.name + (isMe ? " (você)" : "");
    winnerSelect.appendChild(option);
  });
}

// ---------- 4. NAVEGAÇÃO ENTRE OS PAINÉIS (Ações <-> Montar Aumento) ----------

function showActionsPanel() {
  document.getElementById("panel-raise").classList.add("hidden");
  document.getElementById("panel-raise").classList.remove("flex");
  document.getElementById("panel-actions").classList.remove("hidden");
  document.getElementById("panel-actions").classList.add("flex");
  renderActionPanel();
}

function showRaisePanel() {
  document.getElementById("panel-actions").classList.add("hidden");
  document.getElementById("panel-actions").classList.remove("flex");
  document.getElementById("panel-raise").classList.remove("hidden");
  document.getElementById("panel-raise").classList.add("flex");
  renderChipsUI();
}

// ---------- 5. CLIQUE NAS FICHAS (dentro do painel de aumento) ----------

document.querySelectorAll(".chip").forEach(function (chipButton) {
  chipButton.addEventListener("click", function () {
    const color = chipButton.dataset.chipColor;
    const value = Number(chipButton.dataset.chipValue);

    if (myChipCounts[color] <= 0) return;

    myChipCounts[color] -= 1;
    pendingBetChips[color] += 1;
    currentBet += value;

    renderChipsUI();
  });
});

document.getElementById("btn-clear-bet").addEventListener("click", function () {
  for (const color in pendingBetChips) {
    myChipCounts[color] += pendingBetChips[color];
    pendingBetChips[color] = 0;
  }
  currentBet = 0;
  renderChipsUI();
});

document
  .getElementById("btn-action-raise")
  .addEventListener("click", function () {
    if (document.getElementById("btn-action-raise").disabled) return;
    showRaisePanel();
  });

document
  .getElementById("btn-raise-back")
  .addEventListener("click", function () {
    for (const color in pendingBetChips) {
      myChipCounts[color] += pendingBetChips[color];
      pendingBetChips[color] = 0;
    }
    currentBet = 0;
    renderChipsUI();
    showActionsPanel();
  });

// ---------- 6. CONFIRMAR O AUMENTO ----------

document
  .getElementById("btn-confirm-bet")
  .addEventListener("click", async function () {
    if (currentBet <= 0) return;

    const betAmount = currentBet;
    const me = playersCache.find(function (p) {
      return p.id === myPlayerId;
    });
    if (!me) return;

    const newChips = me.chips - betAmount;
    const newBet = me.current_bet + betAmount;

    const { error: playerError } = await supabaseClient
      .from("players")
      .update({ chips: newChips, current_bet: newBet })
      .eq("id", myPlayerId);

    if (playerError) {
      alert("Não foi possível confirmar o aumento: " + playerError.message);
      return;
    }

    const { data: roomRow } = await supabaseClient
      .from("rooms")
      .select("pot")
      .eq("id", roomCode)
      .single();

    await supabaseClient
      .from("rooms")
      .update({ pot: (roomRow ? roomRow.pot : potTotal) + betAmount })
      .eq("id", roomCode);

    lastKnownChips = newChips;
    currentBet = 0;
    pendingBetChips = {
      preta: 0,
      azul: 0,
      vermelha: 0,
      verde: 0,
      branca: 0,
      amarela: 0,
    };
    renderChipsUI();
    showActionsPanel();
  });

// ---------- 7. COBRIR APOSTA (CALL) ----------

document
  .getElementById("btn-action-call")
  .addEventListener("click", async function () {
    if (document.getElementById("btn-action-call").disabled) return;
    if (currentCallAmount <= 0) return;

    const amount = currentCallAmount;
    const me = playersCache.find(function (p) {
      return p.id === myPlayerId;
    });
    if (!me) return;

    removeChipsForAmount(myChipCounts, amount);

    const newChips = me.chips - amount;
    const newBet = me.current_bet + amount;

    await supabaseClient
      .from("players")
      .update({ chips: newChips, current_bet: newBet })
      .eq("id", myPlayerId);

    const { data: roomRow } = await supabaseClient
      .from("rooms")
      .select("pot")
      .eq("id", roomCode)
      .single();

    await supabaseClient
      .from("rooms")
      .update({ pot: (roomRow ? roomRow.pot : potTotal) + amount })
      .eq("id", roomCode);

    lastKnownChips = newChips;
    renderChipsUI();
    renderActionPanel();
  });

// ---------- 8. ALL-IN ----------

document
  .getElementById("btn-action-allin")
  .addEventListener("click", async function () {
    if (document.getElementById("btn-action-allin").disabled) return;

    const me = playersCache.find(function (p) {
      return p.id === myPlayerId;
    });
    if (!me) return;

    const amount = getMyStackTotal();
    if (amount <= 0) return;

    for (const color in myChipCounts) myChipCounts[color] = 0;

    const newChips = me.chips - amount;
    const newBet = me.current_bet + amount;

    await supabaseClient
      .from("players")
      .update({ chips: newChips, current_bet: newBet })
      .eq("id", myPlayerId);

    const { data: roomRow } = await supabaseClient
      .from("rooms")
      .select("pot")
      .eq("id", roomCode)
      .single();

    await supabaseClient
      .from("rooms")
      .update({ pot: (roomRow ? roomRow.pot : potTotal) + amount })
      .eq("id", roomCode);

    lastKnownChips = newChips;
    renderChipsUI();
    renderActionPanel();
  });

// ---------- 9. DESISTIR (FOLD) ----------

document
  .getElementById("btn-action-fold")
  .addEventListener("click", async function () {
    hasFolded = !hasFolded;

    const foldBtn = document.getElementById("btn-action-fold");
    foldBtn.querySelector("span").textContent = hasFolded
      ? "Voltar pra rodada"
      : "Desistir";

    await supabaseClient
      .from("players")
      .update({ folded: hasFolded })
      .eq("id", myPlayerId);
  });

// ---------- 10. COBRAR ANTE (só o dono da sala vê este botão) ----------

document
  .getElementById("btn-force-ante")
  .addEventListener("click", async function () {
    const { data: roomRow } = await supabaseClient
      .from("rooms")
      .select("pot, ante_amount")
      .eq("id", roomCode)
      .single();

    if (!roomRow) return;
    const anteAmount = roomRow.ante_amount;

    const activePlayers = playersCache.filter(function (p) {
      return !p.folded;
    });

    await Promise.all(
      activePlayers.map(function (p) {
        return supabaseClient
          .from("players")
          .update({
            chips: p.chips - anteAmount,
            current_bet: p.current_bet + anteAmount,
          })
          .eq("id", p.id);
      }),
    );

    await supabaseClient
      .from("rooms")
      .update({ pot: roomRow.pot + anteAmount * activePlayers.length })
      .eq("id", roomCode);
  });

// ---------- 11. ENTREGAR POTE AO VENCEDOR ----------

document
  .getElementById("btn-give-pot")
  .addEventListener("click", async function () {
    const select = document.getElementById("select-winner");
    const winnerId = select.value;
    if (!winnerId) {
      alert("Selecione um jogador antes de entregar o pote.");
      return;
    }

    const { data: roomRow } = await supabaseClient
      .from("rooms")
      .select("pot")
      .eq("id", roomCode)
      .single();
    const potAmount = roomRow ? roomRow.pot : potTotal;

    const winner = playersCache.find(function (p) {
      return p.id === winnerId;
    });
    if (!winner) return;

    await supabaseClient
      .from("players")
      .update({ chips: winner.chips + potAmount })
      .eq("id", winnerId);

    await Promise.all(
      playersCache.map(function (p) {
        return supabaseClient
          .from("players")
          .update({ current_bet: 0, folded: false })
          .eq("id", p.id);
      }),
    );

    await supabaseClient.from("rooms").update({ pot: 0 }).eq("id", roomCode);

    hasFolded = false;
    document
      .getElementById("btn-action-fold")
      .querySelector("span").textContent = "Desistir";
    showActionsPanel();
  });

// ---------- 12. MODAL DE REGRAS ----------

const rulesModal = document.getElementById("modal-rules");

function openRulesModal() {
  rulesModal.classList.remove("hidden");
  rulesModal.classList.add("flex");
}

function closeRulesModal() {
  rulesModal.classList.add("hidden");
  rulesModal.classList.remove("flex");
}

document
  .getElementById("btn-rules-fab")
  .addEventListener("click", openRulesModal);
document
  .getElementById("btn-close-rules")
  .addEventListener("click", closeRulesModal);

rulesModal.addEventListener("click", function (event) {
  if (event.target === rulesModal) closeRulesModal();
});

// ---------- 13. SAIR DA SALA ----------

document
  .getElementById("link-leave-room")
  .addEventListener("click", function () {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    // deixa o navegador seguir o link normalmente até home.html
  });

// ---------- 14. REALTIME: buscar jogadores e ouvir mudanças ----------

async function refreshPlayers() {
  const { data, error } = await supabaseClient
    .from("players")
    .select("*")
    .eq("room_code", roomCode)
    .order("joined_at", { ascending: true });

  if (error || !data) return;

  playersCache = data;
  renderLeaderboard(data);

  const me = data.find(function (p) {
    return p.id === myPlayerId;
  });
  if (me && me.chips !== lastKnownChips) {
    const delta = me.chips - lastKnownChips;
    if (delta > 0) addChipsFromAmount(myChipCounts, delta);
    else removeChipsForAmount(myChipCounts, -delta);
    lastKnownChips = me.chips;
    renderChipsUI();
  }

  if (me) {
    hasFolded = me.folded;
    const foldBtn = document.getElementById("btn-action-fold");
    foldBtn.querySelector("span").textContent = hasFolded
      ? "Voltar pra rodada"
      : "Desistir";
    document.querySelectorAll(".chip").forEach(function (c) {
      c.disabled = hasFolded || myChipCounts[c.dataset.chipColor] <= 0;
    });
  }

  renderActionPanel();
}

function subscribeToRoom() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  realtimeChannel = supabaseClient
    .channel("room-" + roomCode)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "players",
        filter: "room_code=eq." + roomCode,
      },
      function () {
        refreshPlayers();
      },
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "rooms",
        filter: "id=eq." + roomCode,
      },
      function (payload) {
        potTotal = payload.new.pot;
        renderPotUI();
      },
    )
    .subscribe();
}

// ---------- 15. INICIALIZAÇÃO DA PÁGINA ----------

document.getElementById("room-code-display").textContent = roomCode;
document.getElementById("btn-force-ante").classList.toggle("hidden", !isHost);

renderChipsUI();
renderPotUI();
subscribeToRoom();
refreshPlayers();
