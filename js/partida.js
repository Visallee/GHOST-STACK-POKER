import { supabaseClient } from "./supabase.js";
import { loadSession, saveSession, clearSession } from "./session.js";
import { generateRoomCode } from "./room-code.js";
import { CHIP_VALUES, formatMoney } from "./chips.js";
import {
  getOccupiedSeats,
  getActiveSeats,
  computeNextDealerSeat,
  computeBlindSeats,
} from "./turn.js";
import { computeSidePots, splitPotAmongWinners } from "./pots.js";
import { evaluateWinCondition, buildFinalResults } from "./win-condition.js";
import { getAmountToCall, validateBetAmount } from "./betting.js";
import {
  getTableMaxBet,
  applyActionToRound,
  isBettingRoundClosed,
  getNextSeatToAct,
} from "./betting-round.js";
import { HAND_STATE } from "./hand-state.js";
import {
  AFK_KICK_THRESHOLD_MS,
  getAfkRemainingMs,
  isPlayerAfk,
  shouldShowAfkWarning,
  formatCountdown,
  computeNextHostByJoinOrder,
} from "./presence.js";

window.addEventListener("error", function (event) {
  console.error(
    "[GhostStackPoker] Erro não tratado:",
    event.error || event.message,
  );
  reportCriticalErrorOnce(
    "window-error",
    "Erro inesperado na página: " +
      (event.error ? event.error.message : event.message),
  );
});
window.addEventListener("unhandledrejection", function (event) {
  console.error(
    "[GhostStackPoker] Promise rejeitada sem tratamento:",
    event.reason,
  );
  const msg =
    event.reason && event.reason.message
      ? event.reason.message
      : String(event.reason);
  reportCriticalErrorOnce(
    "unhandled-rejection",
    "Uma operação falhou sem aviso: " + msg,
  );
});

const shownErrorKeys = new Set();
function reportCriticalErrorOnce(key, message) {
  if (shownErrorKeys.has(key)) return;
  shownErrorKeys.add(key);
  alert(
    "⚠️ " +
      message +
      "\n\n(Detalhes completos no Console do navegador — F12 → Console.)",
  );
}

const session = loadSession();

if (!session) {
  window.location.href = "home.html";
  throw new Error("Sem sessão ativa — redirecionando para o lobby.");
}

const roomCode = session.roomCode;
const myPlayerId = session.playerId;
const myName = session.playerName;

let isHost = session.isHost;

let currentBet = 0;
let potTotal = 0;
let hasFolded = false;
let currentCallAmount = 0;
let playersCache = [];
let realtimeChannel = null;

let previousPlayerCount = null;
let heartbeatInterval = null;
let presenceCheckInterval = null;
let countdownTickInterval = null;

let joinCode = "------";
let anteCollected = false;
let allowKick = false;
let selectedNewHostId = null;

let isProcessingAction = false;

// Estado de controle para o Modal de Transferência (Fase 7.2)
// Pode ser 'leave' (sair do jogo) ou 'stay' (apenas transferir controle)
let transferMode = "leave";

async function runGuardedAction(button, fn) {
  if (isProcessingAction) return;
  isProcessingAction = true;
  if (button) button.disabled = true;

  try {
    await fn();
  } finally {
    isProcessingAction = false;
    if (button) button.disabled = false;
  }
}

let dealerSeat = null;
let currentTurnSeat = null;
let handState = HAND_STATE.NO_HAND;

let winCondition = "elimination";
let roundLimit = null;
let currentRound = 0;
let gameStatus = "in_progress";
let startingChips = 1000;

async function removePlayerFromRoom(playerId) {
  const player = playersCache.find(function (p) {
    return p.id === playerId;
  });
  if (!player) return;

  if (player.current_bet > 0) {
    await supabaseClient
      .from("players")
      .update({
        left_room: true,
        folded: true,
        chips: 0,
        is_eliminated: true,
      })
      .eq("id", playerId);
  } else {
    await supabaseClient.from("players").delete().eq("id", playerId);
  }
}

function renderChipsUI() {
  const balance = getMyStackTotal();

  Object.keys(CHIP_VALUES).forEach(function (color) {
    const chipButton = document.querySelector(
      `.chip[data-chip-color="${color}"]`,
    );
    if (chipButton) {
      chipButton.disabled = currentBet + CHIP_VALUES[color] > balance;
    }
  });

  const currentBetEl = document.getElementById("current-bet");
  if (currentBetEl) currentBetEl.textContent = formatMoney(currentBet);

  const me = playersCache.find(function (p) {
    return p.id === myPlayerId;
  });
  const alreadyBet = me ? me.current_bet : 0;
  const maxBet = getMaxTableBet();
  const toCall = getAmountToCall(alreadyBet, maxBet);

  const balanceEl = document.getElementById("raise-balance-display");
  const alreadyBetEl = document.getElementById("raise-already-bet-display");
  const toCallEl = document.getElementById("raise-to-call-display");
  const totalAfterEl = document.getElementById("raise-total-after-display");
  const confirmBtn = document.getElementById("btn-confirm-bet");
  const validationMsg = document.getElementById("raise-validation-message");

  if (balanceEl) balanceEl.textContent = formatMoney(balance);
  if (alreadyBetEl) alreadyBetEl.textContent = formatMoney(alreadyBet);
  if (toCallEl) toCallEl.textContent = formatMoney(toCall);
  if (totalAfterEl)
    totalAfterEl.textContent = formatMoney(alreadyBet + currentBet);

  if (confirmBtn && validationMsg) {
    if (currentBet <= 0) {
      confirmBtn.disabled = true;
      validationMsg.classList.add("hidden");
    } else {
      const result = validateBetAmount(currentBet, balance, alreadyBet, maxBet);
      confirmBtn.disabled = !result.valid;
      if (result.valid) {
        validationMsg.classList.add("hidden");
      } else {
        validationMsg.textContent = result.reason;
        validationMsg.classList.remove("hidden");
      }
    }
  }
}

function renderPotUI() {
  const potEl = document.getElementById("pot-total");
  if (potEl) potEl.textContent = formatMoney(potTotal);
}

function renderRoomCodeUI() {
  document.getElementById("room-code-display").textContent = joinCode;
}

function getMySeatNumber() {
  const me = playersCache.find(function (p) {
    return p.id === myPlayerId;
  });
  return me ? me.seat_number : null;
}

function isMyTurn() {
  const mySeat = getMySeatNumber();
  return (
    handState === HAND_STATE.BETTING &&
    mySeat !== null &&
    mySeat !== undefined &&
    mySeat === currentTurnSeat
  );
}

function getCurrentTurnPlayer() {
  return (
    playersCache.find(function (p) {
      return p.seat_number === currentTurnSeat;
    }) || null
  );
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

  const previousMaxBet = getMaxTableBet();
  const projected = buildProjectedPlayers(overrides);
  const myProjected = projected.find(function (p) {
    return p.id === myPlayerId;
  });
  const myNewBet = myProjected ? myProjected.current_bet : 0;

  const updatedPlayers = applyActionToRound(
    projected,
    myPlayerId,
    myNewBet,
    previousMaxBet,
  );
  playersCache = updatedPlayers;

  const newMaxBet = getTableMaxBet(updatedPlayers);
  const closed = isBettingRoundClosed(updatedPlayers, newMaxBet);

  await Promise.all(
    updatedPlayers.map(function (p) {
      return supabaseClient
        .from("players")
        .update({ has_acted_this_round: p.has_acted_this_round })
        .eq("id", p.id);
    }),
  );

  if (closed) {
    handState = HAND_STATE.ROUND_COMPLETE;
    currentTurnSeat = null;
    await supabaseClient
      .from("rooms")
      .update({
        current_turn_seat: null,
        hand_state: HAND_STATE.ROUND_COMPLETE,
      })
      .eq("id", roomCode);
  } else {
    const occupiedSeats = getOccupiedSeats(updatedPlayers);
    const nextSeat = getNextSeatToAct(
      occupiedSeats,
      updatedPlayers,
      newMaxBet,
      mySeat,
    );

    currentTurnSeat = nextSeat;
    handState =
      nextSeat === null ? HAND_STATE.ROUND_COMPLETE : HAND_STATE.BETTING;

    await supabaseClient
      .from("rooms")
      .update({ current_turn_seat: nextSeat, hand_state: handState })
      .eq("id", roomCode);
  }

  renderLeaderboard(playersCache);
  renderActionPanel();
  renderHostUI();
}

function renderHostUI() {
  document
    .getElementById("btn-open-room-settings")
    .classList.toggle("hidden", !isHost);
  document.getElementById("panel-give-pot").classList.toggle("hidden", !isHost);

  document
    .getElementById("btn-start-hand")
    .classList.toggle("hidden", !(isHost && handState === HAND_STATE.NO_HAND));
  document
    .getElementById("btn-force-ante")
    .classList.toggle(
      "hidden",
      !(isHost && handState === HAND_STATE.WAITING_FOR_ANTE),
    );
}

function getMaxTableBet() {
  return getTableMaxBet(playersCache);
}

function getMyStackTotal() {
  const me = playersCache.find(function (p) {
    return p.id === myPlayerId;
  });
  return me ? me.chips : 0;
}

function renderActionPanel() {
  if (!document.getElementById("panel-eliminated").classList.contains("hidden"))
    return;

  const me = playersCache.find(function (p) {
    return p.id === myPlayerId;
  });
  const myBet = me ? me.current_bet : 0;
  const maxBet = getMaxTableBet();
  const myStack = getMyStackTotal();

  currentCallAmount = getAmountToCall(myBet, maxBet);

  document.getElementById("my-stack-display").textContent =
    formatMoney(myStack);
  document.getElementById("table-max-bet-display").textContent =
    formatMoney(maxBet);
  document.getElementById("call-amount-label").textContent =
    currentCallAmount > 0 ? formatMoney(currentCallAmount) : "nada a cobrir";
  document.getElementById("call-action-label").textContent =
    currentCallAmount > 0 ? "Cobrir Aposta" : "Passar";
  document.getElementById("allin-amount-label").textContent =
    formatMoney(myStack);

  const callBtn = document.getElementById("btn-action-call");
  const raiseBtn = document.getElementById("btn-action-raise");
  const allinBtn = document.getElementById("btn-action-allin");

  callBtn.disabled = myStack < currentCallAmount;
  raiseBtn.disabled = myStack <= currentCallAmount;
  allinBtn.disabled = myStack <= 0;

  const myTurn = isMyTurn();
  const grid = document.getElementById("action-buttons-grid");
  const statusLabel = document.getElementById("turn-status-label");
  const waitingMsg = document.getElementById("turn-waiting-message");

  grid.classList.toggle("hidden", !myTurn);
  statusLabel.classList.toggle("hidden", !myTurn);
  waitingMsg.classList.toggle("hidden", myTurn);

  if (!myTurn) {
    if (handState === HAND_STATE.NO_HAND) {
      waitingMsg.textContent = "Aguardando o Host iniciar a mão.";
    } else if (handState === HAND_STATE.WAITING_FOR_ANTE) {
      waitingMsg.textContent = "Aguardando o Host cobrar o Ante.";
    } else if (handState === HAND_STATE.ROUND_COMPLETE) {
      waitingMsg.textContent =
        "Apostas encerradas — aguardando o Host distribuir o pote.";
    } else {
      const turnPlayer = getCurrentTurnPlayer();
      waitingMsg.textContent =
        "Aguardando " +
        (turnPlayer ? turnPlayer.name : "outro jogador") +
        " jogar...";
    }

    const raisePanel = document.getElementById("panel-raise");
    if (!raisePanel.classList.contains("hidden")) {
      currentBet = 0;
      renderChipsUI();
      showActionsPanel();
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderLeaderboard(players) {
  const listEl = document.getElementById("players-list");
  listEl.innerHTML = "";

  players.forEach(function (p) {
    const isMe = p.id === myPlayerId;
    const isPlayersTurn =
      currentTurnSeat !== null && p.seat_number === currentTurnSeat;
    const isDealer = dealerSeat !== null && p.seat_number === dealerSeat;

    const card = document.createElement("div");
    card.className =
      "player-card flex items-center justify-between px-4 py-3" +
      (p.folded ? " is-folded" : "") +
      (isMe ? " is-turn" : "") +
      (isPlayersTurn ? " active-player-turn" : "");

    let statusText;
    let statusClass;

    if (p.left_room) {
      statusText = "abandonou a mão";
      statusClass = "text-burgundy opacity-50";
    } else if (p.sitting_out) {
      statusText = "em espera...";
      statusClass = "text-blue-300 opacity-60";
    } else if (p.is_eliminated) {
      statusText = "eliminado";
      statusClass = "text-burgundy";
    } else if (p.folded) {
      statusText = "desistiu";
      statusClass = "text-burgundy";
    } else if (p.current_bet > 0) {
      statusText = "apostou " + formatMoney(p.current_bet);
      statusClass = "text-gold/80";
    } else {
      statusText = "aguardando";
      statusClass = "text-cream/40";
    }

    const dealerBadgeHtml =
      isDealer && !p.sitting_out
        ? '<span class="dealer-badge" title="Botão do Dealer">D</span>'
        : "";
    const turnBadgeHtml =
      isPlayersTurn && !p.sitting_out
        ? '<span class="text-gold text-[10px] font-body font-semibold uppercase tracking-wide ml-1">● vez</span>'
        : "";

    const showKick = isHost && allowKick && !isMe && !p.left_room;
    const kickButtonHtml = showKick
      ? '<button class="btn-kick-player" type="button" aria-label="Expulsar ' +
        escapeHtml(p.name) +
        '" title="Expulsar jogador" data-player-id="' +
        p.id +
        '" data-player-name="' +
        escapeHtml(p.name) +
        '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M16 17l5-5-5-5"/>' +
        '<path d="M21 12H9"/>' +
        '<path d="M13 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/>' +
        "</svg>" +
        "</button>"
      : "";

    const showApproveRebuy =
      isHost && p.is_eliminated && p.needs_rebuy_approval && !p.left_room;
    const approveRebuyHtml = showApproveRebuy
      ? '<button class="btn-approve-rebuy text-gold text-[10px] font-body underline ml-2" type="button" data-player-id="' +
        p.id +
        '">aprovar volta</button>'
      : "";

    const afkHtml =
      !isMe && !p.left_room && shouldShowAfkWarning(p.last_seen_at, Date.now())
        ? '<p class="afk-countdown text-burgundy text-[10px] font-body font-semibold mt-0.5" data-last-seen-at="' +
          p.last_seen_at +
          '">expulso em ' +
          formatCountdown(getAfkRemainingMs(p.last_seen_at, Date.now())) +
          "</p>"
        : "";

    card.innerHTML =
      '<div class="flex items-center gap-2">' +
      '<span class="w-2 h-2 rounded-full ' +
      (isMe ? "bg-gold" : p.is_host ? "bg-burgundy" : "bg-cream/20") +
      '"></span>' +
      '<span class="text-cream font-body font-medium text-sm' +
      (p.is_eliminated || p.left_room ? " opacity-40 line-through" : "") +
      '">' +
      escapeHtml(p.name) +
      (isMe ? " (você)" : "") +
      (p.is_host ? " 👑" : "") +
      "</span>" +
      dealerBadgeHtml +
      turnBadgeHtml +
      "</div>" +
      '<div class="flex items-center">' +
      '<div class="text-right">' +
      '<p class="text-cream font-display text-base leading-none">' +
      formatMoney(p.chips) +
      "</p>" +
      '<p class="' +
      statusClass +
      ' text-[11px] font-body">' +
      statusText +
      "</p>" +
      afkHtml +
      "</div>" +
      approveRebuyHtml +
      kickButtonHtml +
      "</div>";

    listEl.appendChild(card);
  });

  document.querySelectorAll(".btn-approve-rebuy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      handleApproveRebuy(btn.dataset.playerId, btn);
    });
  });

  document.querySelectorAll(".btn-kick-player").forEach(function (btn) {
    btn.addEventListener("click", function () {
      handleKickPlayer(btn.dataset.playerId, btn.dataset.playerName, btn);
    });
  });
}

function renderGivePotPanel() {
  const container = document.getElementById("give-pot-container");
  if (!isHost) {
    container.innerHTML = "";
    return;
  }

  const contributions = playersCache.map(function (p) {
    return { id: p.id, bet: p.current_bet, folded: p.folded };
  });
  const result = computeSidePots(contributions);

  container.innerHTML = "";

  if (result.pots.length === 0 && result.autoAwards.length === 0) {
    container.innerHTML =
      '<p class="text-cream/40 text-xs font-body">Nenhuma aposta na mesa ainda — nada pra entregar.</p>';
    return;
  }

  if (result.autoAwards.length > 0) {
    const info = document.createElement("p");
    info.className = "text-cream/40 text-[11px] font-body mb-3";
    const names = result.autoAwards
      .map(function (a) {
        const p = playersCache.find(function (pp) {
          return pp.id === a.playerId;
        });
        return (
          (p ? p.name : "?") + " (+" + formatMoney(a.amount) + " devolvido)"
        );
      })
      .join(", ");
    info.textContent = "Sem adversário pra disputar: " + names + ".";
    container.appendChild(info);
  }

  result.pots.forEach(function (pot, index) {
    const eligiblePlayers = playersCache.filter(function (p) {
      return pot.eligible_player_ids.indexOf(p.id) !== -1;
    });

    const wrap = document.createElement("div");
    wrap.className = "mb-3 pot-winner-group";
    wrap.dataset.potAmount = pot.amount;

    const label = document.createElement("label");
    label.className = "block text-cream/60 text-xs font-body mb-1";
    label.textContent =
      result.pots.length > 1
        ? "Pote " +
          (index + 1) +
          " de " +
          result.pots.length +
          " — " +
          formatMoney(pot.amount) +
          " (marque mais de 1 em caso de empate)"
        : "Vencedor da rodada — pote de " +
          formatMoney(pot.amount) +
          " (marque mais de 1 em caso de empate)";

    wrap.appendChild(label);

    eligiblePlayers.forEach(function (p) {
      const optionLabel = document.createElement("label");
      optionLabel.className =
        "flex items-center gap-2 py-1.5 px-1 text-cream font-body text-sm";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "pot-winner-checkbox";
      checkbox.value = p.id;
      checkbox.style.accentColor = "#C9A227";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name + (p.id === myPlayerId ? " (você)" : "");

      optionLabel.appendChild(checkbox);
      optionLabel.appendChild(nameSpan);
      wrap.appendChild(optionLabel);
    });

    container.appendChild(wrap);
  });

  const confirmBtn = document.createElement("button");
  confirmBtn.id = "btn-give-pot";
  confirmBtn.type = "button";
  confirmBtn.className =
    "w-full bg-gold text-ink font-body font-semibold py-2.5 rounded-lg text-sm mt-1";
  confirmBtn.textContent =
    result.pots.length > 1
      ? "Entregar todos os potes"
      : result.pots.length === 1
        ? "Entregar pote"
        : "Confirmar devolução";
  confirmBtn.addEventListener("click", handleGivePotClick);
  container.appendChild(confirmBtn);
}

function showActionsPanel() {
  document.getElementById("panel-eliminated").classList.add("hidden");
  document.getElementById("panel-eliminated").classList.remove("flex");
  document.getElementById("panel-raise").classList.add("hidden");
  document.getElementById("panel-raise").classList.remove("flex");
  document.getElementById("panel-actions").classList.remove("hidden");
  document.getElementById("panel-actions").classList.add("flex");
  renderActionPanel();
}

function showEliminatedPanel(needsApproval) {
  document.getElementById("panel-actions").classList.add("hidden");
  document.getElementById("panel-actions").classList.remove("flex");
  document.getElementById("panel-raise").classList.add("hidden");
  document.getElementById("panel-raise").classList.remove("flex");
  document.getElementById("panel-eliminated").classList.remove("hidden");
  document.getElementById("panel-eliminated").classList.add("flex");

  document
    .getElementById("btn-request-rebuy")
    .classList.toggle("hidden", needsApproval);
  document
    .getElementById("rebuy-pending-message")
    .classList.toggle("hidden", !needsApproval);
}

function showRaisePanel() {
  document.getElementById("panel-eliminated").classList.add("hidden");
  document.getElementById("panel-eliminated").classList.remove("flex");
  document.getElementById("panel-actions").classList.add("hidden");
  document.getElementById("panel-actions").classList.remove("flex");
  document.getElementById("panel-raise").classList.remove("hidden");
  document.getElementById("panel-raise").classList.add("flex");

  renderChipsUI();
}

document.querySelectorAll(".chip").forEach(function (chipButton) {
  chipButton.addEventListener("click", function () {
    const color = chipButton.dataset.chipColor;
    const value = CHIP_VALUES[color];
    const balance = getMyStackTotal();

    if (currentBet + value > balance) return;

    currentBet += value;
    renderChipsUI();
  });
});

document.getElementById("btn-clear-bet").addEventListener("click", function () {
  currentBet = 0;
  renderChipsUI();
});

function getTurnNotAllowedReason() {
  if (handState === HAND_STATE.NO_HAND) {
    return 'A mão ainda não começou. O Host precisa clicar em "Iniciar Mão" acima.';
  }
  if (handState === HAND_STATE.WAITING_FOR_ANTE) {
    return 'Aguardando o Host clicar em "Cobrar Antes" para iniciar as apostas.';
  }
  if (handState === HAND_STATE.ROUND_COMPLETE) {
    return "A rodada de apostas encerrou. Aguardando o Host entregar o pote.";
  }
  const turnPlayer = getCurrentTurnPlayer();
  if (turnPlayer) {
    return "Aguarde: agora é a vez de " + turnPlayer.name + " agir.";
  }
  return "Não é sua vez de agir neste momento.";
}

document
  .getElementById("btn-action-raise")
  .addEventListener("click", function () {
    if (!isMyTurn()) {
      alert(getTurnNotAllowedReason());
      renderActionPanel();
      return;
    }
    if (document.getElementById("btn-action-raise").disabled) return;
    showRaisePanel();
  });

document
  .getElementById("btn-raise-back")
  .addEventListener("click", function () {
    currentBet = 0;
    renderChipsUI();
    showActionsPanel();
  });

document
  .getElementById("btn-confirm-bet")
  .addEventListener("click", function () {
    const button = document.getElementById("btn-confirm-bet");
    if (!isMyTurn()) {
      alert(getTurnNotAllowedReason());
      renderActionPanel();
      return;
    }
    runGuardedAction(button, async function () {
      if (!isMyTurn()) return;
      if (currentBet <= 0) return;

      const betAmount = currentBet;
      const me = playersCache.find(function (p) {
        return p.id === myPlayerId;
      });
      if (!me) return;

      const maxBet = getMaxTableBet();
      const validation = validateBetAmount(
        betAmount,
        getMyStackTotal(),
        me.current_bet,
        maxBet,
      );
      if (!validation.valid) {
        alert(validation.reason);
        renderChipsUI();
        return;
      }

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

      currentBet = 0;
      renderChipsUI();
      showActionsPanel();

      await advanceTurnAfterMyAction({ chips: newChips, current_bet: newBet });
    });
  });

document
  .getElementById("btn-action-call")
  .addEventListener("click", function () {
    const button = document.getElementById("btn-action-call");
    if (!isMyTurn()) {
      alert(getTurnNotAllowedReason());
      renderActionPanel();
      return;
    }
    runGuardedAction(button, async function () {
      if (!isMyTurn()) return;
      if (button.disabled) return;

      if (currentCallAmount <= 0) {
        await advanceTurnAfterMyAction({});
        return;
      }

      const amount = currentCallAmount;
      const me = playersCache.find(function (p) {
        return p.id === myPlayerId;
      });
      if (!me) return;

      const maxBet = getMaxTableBet();
      const validation = validateBetAmount(
        amount,
        getMyStackTotal(),
        me.current_bet,
        maxBet,
      );
      if (!validation.valid) {
        alert(validation.reason);
        return;
      }

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

      renderActionPanel();

      await advanceTurnAfterMyAction({ chips: newChips, current_bet: newBet });
    });
  });

document
  .getElementById("btn-action-allin")
  .addEventListener("click", function () {
    const button = document.getElementById("btn-action-allin");
    if (!isMyTurn()) {
      alert(getTurnNotAllowedReason());
      renderActionPanel();
      return;
    }
    runGuardedAction(button, async function () {
      if (!isMyTurn()) return;
      if (button.disabled) return;

      const me = playersCache.find(function (p) {
        return p.id === myPlayerId;
      });
      if (!me) return;

      const amount = getMyStackTotal();
      if (amount <= 0) return;

      const newChips = me.chips - amount;
      const newBet = me.current_bet + amount;

      await supabaseClient
        .from("players")
        .update({ chips: newChips, current_bet: newBet, is_all_in: true })
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

      renderActionPanel();

      await advanceTurnAfterMyAction({
        chips: newChips,
        current_bet: newBet,
        is_all_in: true,
      });
    });
  });

function getAssignmentsFromSidePots(result) {
  const assignments = [];
  result.autoAwards.forEach(function (a) {
    assignments.push({ winnerId: a.playerId, amount: a.amount });
  });
  result.pots.forEach(function (pot) {
    if (pot.eligible_player_ids.length > 0) {
      const splits = splitPotAmongWinners(pot.amount, pot.eligible_player_ids);
      splits.forEach(function (s) {
        assignments.push({ winnerId: s.playerId, amount: s.amount });
      });
    }
  });
  return assignments;
}

document
  .getElementById("btn-action-fold")
  .addEventListener("click", function () {
    const foldBtn = document.getElementById("btn-action-fold");
    if (!isMyTurn()) {
      alert(getTurnNotAllowedReason());
      renderActionPanel();
      return;
    }
    runGuardedAction(foldBtn, async function () {
      if (!isMyTurn()) return;

      const wasFolded = hasFolded;
      hasFolded = !hasFolded;

      foldBtn.querySelector("span").textContent = hasFolded
        ? "Voltar pra rodada"
        : "Desistir";

      await supabaseClient
        .from("players")
        .update({ folded: hasFolded })
        .eq("id", myPlayerId);

      if (hasFolded && !wasFolded) {
        const projected = buildProjectedPlayers({ folded: true });
        const activeSeatsNow = getActiveSeats(projected);

        if (activeSeatsNow.length === 1) {
          const contributions = projected.map(function (p) {
            return { id: p.id, bet: p.current_bet, folded: p.folded };
          });
          const result = computeSidePots(contributions);
          const assignments = getAssignmentsFromSidePots(result);

          if (assignments.length > 0) {
            await resolveEndOfHand(assignments);
            return;
          }
        }

        await advanceTurnAfterMyAction({ folded: true });
      }
    });
  });

document
  .getElementById("btn-start-hand")
  .addEventListener("click", function () {
    const btn = document.getElementById("btn-start-hand");
    runGuardedAction(btn, async function () {
      if (!isHost) return;

      const activeSeatsForNewHand = getActiveSeats(playersCache);
      if (activeSeatsForNewHand.length === 0) return;

      const newDealerSeat = computeNextDealerSeat(
        activeSeatsForNewHand,
        dealerSeat,
      );

      btn.textContent = "Iniciando...";

      await Promise.all(
        playersCache.map(function (p) {
          return supabaseClient
            .from("players")
            .update({ has_acted_this_round: false, is_all_in: false })
            .eq("id", p.id);
        }),
      );

      await supabaseClient
        .from("rooms")
        .update({
          dealer_seat: newDealerSeat,
          current_turn_seat: null,
          hand_state: HAND_STATE.WAITING_FOR_ANTE,
        })
        .eq("id", roomCode);

      dealerSeat = newDealerSeat;
      currentTurnSeat = null;
      handState = HAND_STATE.WAITING_FOR_ANTE;

      btn.textContent = "Iniciar Mão";

      renderHostUI();
      renderLeaderboard(playersCache);
      renderActionPanel();
    });
  });

document
  .getElementById("btn-force-ante")
  .addEventListener("click", function () {
    const btn = document.getElementById("btn-force-ante");
    runGuardedAction(btn, async function () {
      if (!isHost) return;
      if (handState !== HAND_STATE.WAITING_FOR_ANTE) return;

      const { data: roomRow } = await supabaseClient
        .from("rooms")
        .select("pot, ante_amount")
        .eq("id", roomCode)
        .single();

      if (!roomRow) return;
      const anteAmount = roomRow.ante_amount;

      const activePlayers = playersCache.filter(function (p) {
        return !p.folded && !p.is_eliminated && !p.left_room && !p.sitting_out;
      });

      await Promise.all(
        activePlayers.map(function (p) {
          return supabaseClient
            .from("players")
            .update({
              chips: p.chips - anteAmount,
              current_bet: p.current_bet + anteAmount,
              has_acted_this_round: false,
            })
            .eq("id", p.id);
        }),
      );

      playersCache = playersCache.map(function (p) {
        if (p.folded || p.is_eliminated || p.left_room || p.sitting_out)
          return p;
        return Object.assign({}, p, {
          chips: p.chips - anteAmount,
          current_bet: p.current_bet + anteAmount,
          has_acted_this_round: false,
        });
      });

      const totalAnteCollected = anteAmount * activePlayers.length;
      potTotal = (roomRow.pot || 0) + totalAnteCollected;
      renderPotUI();

      const activeSeatsNow = getActiveSeats(playersCache);
      const firstToActSeat = computeBlindSeats(
        activeSeatsNow,
        dealerSeat,
      ).firstToActSeat;

      await supabaseClient
        .from("rooms")
        .update({
          pot: potTotal,
          ante_collected: true,
          hand_state: HAND_STATE.BETTING,
          current_turn_seat: firstToActSeat,
        })
        .eq("id", roomCode);

      anteCollected = true;
      handState = HAND_STATE.BETTING;
      currentTurnSeat = firstToActSeat;

      renderHostUI();
      renderLeaderboard(playersCache);
      renderActionPanel();
    });
  });

async function resolveEndOfHand(assignments) {
  const gains = {};
  assignments.forEach(function (a) {
    gains[a.winnerId] = (gains[a.winnerId] || 0) + a.amount;
  });

  const nowIso = new Date().toISOString();
  let updatedPlayers = playersCache.map(function (p) {
    const gain = gains[p.id] || 0;
    const newChips = p.chips + gain;
    const justEliminated = newChips <= 0 && !p.is_eliminated && !p.sitting_out;

    return Object.assign({}, p, {
      chips: newChips,
      current_bet: 0,
      folded: false,
      has_acted_this_round: false,
      is_all_in: false,
      is_eliminated: newChips <= 0 && !p.sitting_out ? true : p.is_eliminated,
      eliminated_at: justEliminated ? nowIso : p.eliminated_at,
      sitting_out: false,
    });
  });

  const ghosts = updatedPlayers.filter(function (p) {
    return p.left_room;
  });
  const activePlayers = updatedPlayers.filter(function (p) {
    return !p.left_room;
  });

  if (ghosts.length > 0) {
    await Promise.all(
      ghosts.map(function (p) {
        return supabaseClient.from("players").delete().eq("id", p.id);
      }),
    );
  }

  await Promise.all(
    activePlayers.map(function (p) {
      return supabaseClient
        .from("players")
        .update({
          chips: p.chips,
          current_bet: p.current_bet,
          folded: p.folded,
          has_acted_this_round: p.has_acted_this_round,
          is_all_in: p.is_all_in,
          is_eliminated: p.is_eliminated,
          eliminated_at: p.eliminated_at,
          sitting_out: p.sitting_out,
        })
        .eq("id", p.id);
    }),
  );

  const activeSeatsForNextHand = getActiveSeats(activePlayers);
  const newDealerSeat = computeNextDealerSeat(
    activeSeatsForNextHand,
    dealerSeat,
  );

  const newRound = currentRound + 1;
  const winCheck = evaluateWinCondition(activePlayers, {
    win_condition: winCondition,
    round_limit: roundLimit,
    current_round: newRound,
  });

  const roomUpdate = {
    pot: 0,
    ante_collected: false,
    side_pots: [],
    current_round: newRound,
  };

  if (winCheck.finished) {
    roomUpdate.game_status = "finished";
    roomUpdate.final_results = buildFinalResults(activePlayers, winCondition);
    roomUpdate.dealer_seat = null;
    roomUpdate.current_turn_seat = null;
    roomUpdate.hand_state = HAND_STATE.NO_HAND;
  } else {
    roomUpdate.dealer_seat = newDealerSeat;
    roomUpdate.current_turn_seat = null;
    roomUpdate.hand_state = HAND_STATE.WAITING_FOR_ANTE;
  }

  await supabaseClient.from("rooms").update(roomUpdate).eq("id", roomCode);

  playersCache = activePlayers;

  if (!winCheck.finished) {
    dealerSeat = newDealerSeat;
    currentTurnSeat = null;
    handState = HAND_STATE.WAITING_FOR_ANTE;
  }

  hasFolded = false;
  document.getElementById("btn-action-fold").querySelector("span").textContent =
    "Desistir";
  showActionsPanel();

  anteCollected = false;
  currentRound = newRound;
  renderHostUI();
  renderLeaderboard(playersCache);
  renderGivePotPanel();

  if (winCheck.finished) {
    gameStatus = "finished";
    handState = HAND_STATE.NO_HAND;
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    window.location.href = "lobby.html";
  }
}

function handleGivePotClick() {
  const btn = document.getElementById("btn-give-pot");
  runGuardedAction(btn, async function () {
    if (!isHost) return;

    const assignments = [];

    const contributions = playersCache.map(function (p) {
      return { id: p.id, bet: p.current_bet, folded: p.folded };
    });
    const result = computeSidePots(contributions);

    result.autoAwards.forEach(function (a) {
      assignments.push({ winnerId: a.playerId, amount: a.amount });
    });

    const groups = document.querySelectorAll(".pot-winner-group");
    for (const group of groups) {
      const potAmount = Number(group.dataset.potAmount);
      const checked = group.querySelectorAll(".pot-winner-checkbox:checked");

      if (checked.length === 0) {
        alert(
          "Selecione pelo menos 1 vencedor para cada pote antes de confirmar (marque mais de 1 em caso de empate).",
        );
        return;
      }

      const winnerIds = Array.from(checked).map(function (cb) {
        return cb.value;
      });
      const splits = splitPotAmongWinners(potAmount, winnerIds);
      splits.forEach(function (s) {
        assignments.push({ winnerId: s.playerId, amount: s.amount });
      });
    }

    if (assignments.length === 0) return;

    if (btn) btn.textContent = "Entregando...";

    await resolveEndOfHand(assignments);
  });
}

const roomSettingsModal = document.getElementById("modal-room-settings");

document
  .getElementById("btn-open-room-settings")
  .addEventListener("click", function () {
    if (!isHost) return;
    roomSettingsModal.classList.remove("hidden");
    roomSettingsModal.classList.add("flex");
  });

document
  .getElementById("btn-close-room-settings")
  .addEventListener("click", function () {
    roomSettingsModal.classList.add("hidden");
    roomSettingsModal.classList.remove("flex");
  });

roomSettingsModal.addEventListener("click", function (event) {
  if (event.target === roomSettingsModal) {
    roomSettingsModal.classList.add("hidden");
    roomSettingsModal.classList.remove("flex");
  }
});

document
  .getElementById("btn-trocar-codigo")
  .addEventListener("click", function () {
    const btn = document.getElementById("btn-trocar-codigo");
    runGuardedAction(btn, async function () {
      if (!isHost) return;

      btn.textContent = "Gerando...";

      let success = false;
      let attempts = 0;

      while (!success && attempts < 5) {
        const candidate = generateRoomCode();
        const { error } = await supabaseClient
          .from("rooms")
          .update({ join_code: candidate })
          .eq("id", roomCode);

        if (!error) {
          success = true;
          joinCode = candidate;
          renderRoomCodeUI();
        }
        attempts++;
      }

      btn.textContent = success ? "Código trocado!" : "Trocar código da sala";
      if (!success) {
        alert(
          "Não foi possível gerar um novo código agora. Tente de novo em alguns segundos.",
        );
      } else {
        setTimeout(function () {
          btn.textContent = "Trocar código da sala";
        }, 1500);
      }
    });
  });

// ==========================================
// FASE 7.1 — ENCERRAMENTO SEGURO DA PARTIDA
// ==========================================
document
  .getElementById("btn-encerrar-partida")
  .addEventListener("click", function () {
    const btn = document.getElementById("btn-encerrar-partida");
    runGuardedAction(btn, async function () {
      if (!isHost) return;

      const confirmed = confirm(
        "Tem certeza que deseja encerrar a partida? Se houver uma mão em andamento, as apostas não resolvidas serão devolvidas.",
      );
      if (!confirmed) return;

      btn.textContent = "Encerrando...";

      const refunds = [];
      let updatedPlayers = playersCache.map(function (p) {
        if (p.current_bet > 0) {
          refunds.push(p);
          return Object.assign({}, p, {
            chips: p.chips + p.current_bet,
            current_bet: 0,
          });
        }
        return p;
      });

      if (refunds.length > 0) {
        await Promise.all(
          refunds.map(function (p) {
            return supabaseClient
              .from("players")
              .update({ chips: p.chips + p.current_bet, current_bet: 0 })
              .eq("id", p.id);
          }),
        );
      }

      const ghosts = updatedPlayers.filter(function (p) {
        return p.left_room;
      });
      if (ghosts.length > 0) {
        await Promise.all(
          ghosts.map(function (p) {
            return supabaseClient.from("players").delete().eq("id", p.id);
          }),
        );
        updatedPlayers = updatedPlayers.filter(function (p) {
          return !p.left_room;
        });
      }

      playersCache = updatedPlayers;
      const finalResults = buildFinalResults(playersCache, winCondition);

      await supabaseClient
        .from("rooms")
        .update({
          game_status: "finished",
          final_results: finalResults,
          hand_state: HAND_STATE.NO_HAND,
          current_turn_seat: null,
          dealer_seat: null,
          pot: 0,
        })
        .eq("id", roomCode);

      gameStatus = "finished";
      handState = HAND_STATE.NO_HAND;
      if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
      window.location.href = "lobby.html";
    });
  });

function handleKickPlayer(playerId, playerName, button) {
  runGuardedAction(button, async function () {
    if (!isHost || !allowKick) return;
    const confirmed = confirm(
      "Expulsar " + playerName + " da sala? Essa ação não pode ser desfeita.",
    );
    if (!confirmed) return;

    const kickedPlayer = playersCache.find(function (p) {
      return p.id === playerId;
    });

    if (kickedPlayer && kickedPlayer.current_bet > 0) {
      kickedPlayer.left_room = true;
      kickedPlayer.folded = true;
      kickedPlayer.chips = 0;
      kickedPlayer.is_eliminated = true;
    } else {
      playersCache = playersCache.filter(function (p) {
        return p.id !== playerId;
      });
    }

    renderLeaderboard(playersCache);
    renderGivePotPanel();

    await removePlayerFromRoom(playerId);

    if (
      kickedPlayer &&
      kickedPlayer.seat_number === currentTurnSeat &&
      handState === HAND_STATE.BETTING
    ) {
      const occupiedSeats = getOccupiedSeats(playersCache);
      const maxBet = getMaxTableBet();
      const nextSeat = getNextSeatToAct(
        occupiedSeats,
        playersCache,
        maxBet,
        kickedPlayer.seat_number,
      );

      currentTurnSeat = nextSeat;
      handState =
        nextSeat === null ? HAND_STATE.ROUND_COMPLETE : HAND_STATE.BETTING;

      await supabaseClient
        .from("rooms")
        .update({ current_turn_seat: nextSeat, hand_state: handState })
        .eq("id", roomCode);

      renderHostUI();
      renderActionPanel();
    }
  });
}

document
  .getElementById("btn-request-rebuy")
  .addEventListener("click", function () {
    const btn = document.getElementById("btn-request-rebuy");
    runGuardedAction(btn, async function () {
      btn.textContent = "Enviando...";

      await supabaseClient
        .from("players")
        .update({ needs_rebuy_approval: true })
        .eq("id", myPlayerId);

      btn.textContent = "Pedir para voltar a jogar";
    });
  });

function handleApproveRebuy(playerId, button) {
  runGuardedAction(button, async function () {
    if (!isHost) return;

    await supabaseClient
      .from("players")
      .update({
        is_eliminated: false,
        needs_rebuy_approval: false,
        eliminated_at: null,
        chips: startingChips,
        current_bet: 0,
        folded: false,
        has_acted_this_round: false,
        is_all_in: false,
      })
      .eq("id", playerId);
  });
}

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

// ==========================================
// FASE 7.2 — TRANSFERÊNCIA DE HOST DURANTE A PARTIDA
// ==========================================
const transferModal = document.getElementById("modal-transfer-host");
const transferList = document.getElementById("transfer-host-list");
const transferIntro = document.getElementById("transfer-host-intro");
const transferTitle = document.getElementById("transfer-host-title");
const btnConfirmTransfer = document.getElementById("btn-confirm-transfer");

let transferMode = "leave";

function openTransferModal(mode = "leave") {
  transferMode = mode;
  selectedNewHostId = null;
  btnConfirmTransfer.disabled = true;

  transferTitle.textContent =
    mode === "leave" ? "Antes de sair..." : "Passar a coroa";
  btnConfirmTransfer.textContent =
    mode === "leave" ? "Confirmar e sair" : "Confirmar transferência";

  const others = playersCache.filter(function (p) {
    return p.id !== myPlayerId && !p.left_room;
  });

  if (others.length === 0) {
    if (mode === "leave") {
      transferIntro.textContent =
        "Você é o único jogador na mesa. Sair vai encerrar a sala.";
      transferList.innerHTML = "";
      btnConfirmTransfer.disabled = false;
      btnConfirmTransfer.textContent = "Encerrar sala e sair";
    } else {
      transferIntro.textContent =
        "Você é o único jogador na mesa. Não há ninguém para receber a coroa.";
      transferList.innerHTML = "";
      btnConfirmTransfer.disabled = true;
    }
  } else {
    transferIntro.textContent = "Escolha quem vai assumir como Host da mesa.";
    transferList.innerHTML = "";
    others.forEach(function (p) {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "player-card flex items-center justify-between px-4 py-3 w-full text-left transfer-host-option";
      item.dataset.playerId = p.id;
      item.innerHTML =
        '<span class="text-cream font-body font-medium text-sm">' +
        escapeHtml(p.name) +
        "</span>" +
        '<span class="text-cream/40 text-xs font-body">' +
        formatMoney(p.chips) +
        "</span>";

      item.addEventListener("click", function () {
        selectedNewHostId = p.id;
        btnConfirmTransfer.disabled = false;
        document
          .querySelectorAll(".transfer-host-option")
          .forEach(function (el) {
            el.classList.remove("is-turn");
          });
        item.classList.add("is-turn");
      });

      transferList.appendChild(item);
    });
  }

  transferModal.classList.remove("hidden");
  transferModal.classList.add("flex");
}

function closeTransferModal() {
  transferModal.classList.add("hidden");
  transferModal.classList.remove("flex");
}

document
  .getElementById("btn-passar-coroa")
  .addEventListener("click", function () {
    if (!isHost) return;
    roomSettingsModal.classList.add("hidden");
    roomSettingsModal.classList.remove("flex");
    openTransferModal("stay");
  });

document
  .getElementById("btn-cancel-transfer")
  .addEventListener("click", closeTransferModal);

document
  .getElementById("link-leave-room")
  .addEventListener("click", async function (event) {
    if (isHost) {
      event.preventDefault();
      openTransferModal("leave");
    } else {
      event.preventDefault();
      if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
      await removePlayerFromRoom(myPlayerId);
      clearSession();
      window.location.href = "home.html";
    }
  });

btnConfirmTransfer.addEventListener("click", function () {
  runGuardedAction(btnConfirmTransfer, async function () {
    btnConfirmTransfer.textContent =
      transferMode === "leave" ? "Saindo..." : "Transferindo...";

    if (selectedNewHostId === null) {
      if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
      await supabaseClient.from("rooms").delete().eq("id", roomCode);
      clearSession();
      window.location.href = "home.html";
    } else {
      await supabaseClient
        .from("players")
        .update({ is_host: true })
        .eq("id", selectedNewHostId);
      await supabaseClient
        .from("players")
        .update({ is_host: false })
        .eq("id", myPlayerId);
      await supabaseClient
        .from("rooms")
        .update({ host_id: selectedNewHostId })
        .eq("id", roomCode);

      if (transferMode === "leave") {
        if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
        await removePlayerFromRoom(myPlayerId);
        clearSession();
        window.location.href = "home.html";
      } else {
        closeTransferModal();
        isHost = false;
        saveSession({
          roomCode: roomCode,
          playerId: myPlayerId,
          playerName: myName,
          isHost: false,
        });
        renderHostUI();
        renderLeaderboard(playersCache);
      }
    }
  });
});

async function sendHeartbeat() {
  await supabaseClient
    .from("players")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", myPlayerId);
}

async function promoteMeToHost(oldHostId) {
  await supabaseClient
    .from("players")
    .update({ is_host: false })
    .eq("id", oldHostId);
  await supabaseClient
    .from("players")
    .update({ is_host: true })
    .eq("id", myPlayerId);
  await supabaseClient
    .from("rooms")
    .update({ host_id: myPlayerId })
    .eq("id", roomCode);
}

async function kickAfkPlayer(afkPlayer) {
  await removePlayerFromRoom(afkPlayer.id);

  if (
    afkPlayer.seat_number === currentTurnSeat &&
    handState === HAND_STATE.BETTING
  ) {
    const occupiedSeats = getOccupiedSeats(playersCache);
    const maxBet = getMaxTableBet();
    const nextSeat = getNextSeatToAct(
      occupiedSeats,
      playersCache,
      maxBet,
      afkPlayer.seat_number,
    );

    currentTurnSeat = nextSeat;
    handState =
      nextSeat === null ? HAND_STATE.ROUND_COMPLETE : HAND_STATE.BETTING;

    await supabaseClient
      .from("rooms")
      .update({ current_turn_seat: nextSeat, hand_state: handState })
      .eq("id", roomCode);
  }
}

async function checkPresence() {
  if (!playersCache || playersCache.length === 0) return;

  const nowMs = Date.now();
  const currentHost = playersCache.find(function (p) {
    return p.is_host && !p.left_room;
  });

  if (currentHost && isPlayerAfk(currentHost.last_seen_at, nowMs)) {
    const nextHostId = computeNextHostByJoinOrder(
      playersCache,
      nowMs,
      currentHost.id,
    );
    if (nextHostId === myPlayerId) {
      await promoteMeToHost(currentHost.id);
    }
    return;
  }

  if (!isHost) return;
  const activeCount = playersCache.filter(function (p) {
    return !p.left_room;
  }).length;
  if (activeCount <= 1) return;

  const afkPlayer = playersCache.find(function (p) {
    return (
      p.id !== myPlayerId && !p.left_room && isPlayerAfk(p.last_seen_at, nowMs)
    );
  });

  if (afkPlayer) {
    await kickAfkPlayer(afkPlayer);
  }
}

function tickAfkCountdowns() {
  const nowMs = Date.now();
  document.querySelectorAll(".afk-countdown").forEach(function (el) {
    const lastSeenAt = el.dataset.lastSeenAt;
    if (!lastSeenAt) return;
    const remaining = getAfkRemainingMs(lastSeenAt, nowMs);
    el.textContent = "expulso em " + formatCountdown(remaining);
  });
}

async function handleSoloWinner(soloPlayer) {
  if (!soloPlayer.is_host) {
    await supabaseClient
      .from("players")
      .update({ is_host: true })
      .eq("id", soloPlayer.id);
  }

  const { data: roomRow } = await supabaseClient
    .from("rooms")
    .select("pot")
    .eq("id", roomCode)
    .single();
  const potAmount = roomRow ? roomRow.pot : potTotal;

  const finalChips = soloPlayer.chips + potAmount;
  const finalResults = [
    {
      player_id: soloPlayer.id,
      name: soloPlayer.name,
      chips: finalChips,
      rank: 1,
    },
  ];

  await supabaseClient
    .from("players")
    .update({ chips: finalChips, current_bet: 0 })
    .eq("id", soloPlayer.id);

  await supabaseClient
    .from("rooms")
    .update({
      host_id: soloPlayer.id,
      pot: 0,
      game_status: "finished",
      final_results: finalResults,
      hand_state: HAND_STATE.NO_HAND,
      current_turn_seat: null,
      dealer_seat: null,
    })
    .eq("id", roomCode);

  if (soloPlayer.id === myPlayerId) {
    gameStatus = "finished";
    handState = HAND_STATE.NO_HAND;
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (presenceCheckInterval) clearInterval(presenceCheckInterval);
    if (countdownTickInterval) clearInterval(countdownTickInterval);
    window.location.href = "lobby.html";
  }
}

function startPresenceSystem() {
  sendHeartbeat();

  heartbeatInterval = setInterval(function () {
    if (!document.hidden) sendHeartbeat();
  }, 15000);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) sendHeartbeat();
  });

  presenceCheckInterval = setInterval(function () {
    checkPresence();
  }, 10000);

  countdownTickInterval = setInterval(tickAfkCountdowns, 1000);
}

async function refreshPlayers() {
  const { data, error } = await supabaseClient
    .from("players")
    .select("*")
    .eq("room_code", roomCode)
    .order("joined_at", { ascending: true });

  if (error) {
    console.error(
      "[GhostStackPoker] Falha ao buscar jogadores da sala:",
      error,
    );
    reportCriticalErrorOnce(
      "players-fetch",
      "Não consegui carregar os jogadores da sala: " + error.message,
    );
    return;
  }
  if (!data) return;

  const me = data.find(function (p) {
    return p.id === myPlayerId;
  });

  if (!me || me.left_room) {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    alert("Você foi removido desta sala.");
    window.location.href = "home.html";
    return;
  }

  playersCache = data;
  renderLeaderboard(data);
  renderGivePotPanel();

  if (
    previousPlayerCount !== null &&
    previousPlayerCount > 1 &&
    data.filter(function (p) {
      return !p.left_room;
    }).length === 1
  ) {
    const soloPlayer = data.find(function (p) {
      return !p.left_room;
    });
    if (soloPlayer) handleSoloWinner(soloPlayer);
  }
  previousPlayerCount = data.filter(function (p) {
    return !p.left_room;
  }).length;

  if (me.is_host !== isHost) {
    isHost = me.is_host;
    saveSession({
      roomCode: roomCode,
      playerId: myPlayerId,
      playerName: myName,
      isHost: isHost,
    });
    renderHostUI();
  }

  hasFolded = me.folded;
  const foldBtn = document.getElementById("btn-action-fold");
  foldBtn.querySelector("span").textContent = hasFolded
    ? "Voltar pra rodada"
    : "Desistir";
  renderChipsUI();
  document.querySelectorAll(".chip").forEach(function (c) {
    if (hasFolded) c.disabled = true;
  });

  if (me.is_eliminated) {
    showEliminatedPanel(me.needs_rebuy_approval);
  } else if (
    !document.getElementById("panel-eliminated").classList.contains("hidden")
  ) {
    showActionsPanel();
  } else {
    renderActionPanel();
  }
}

async function refreshRoomInfo() {
  const { data: room, error } = await supabaseClient
    .from("rooms")
    .select("*")
    .eq("id", roomCode)
    .single();

  if (error) {
    console.error("[GhostStackPoker] Falha ao buscar dados da sala:", error);
    reportCriticalErrorOnce(
      "room-fetch",
      'Não consegui carregar os dados da sala (código "' +
        roomCode +
        '"): ' +
        error.message,
    );
    return;
  }
  if (!room) {
    console.error(
      "[GhostStackPoker] Sala não encontrada no banco para o id:",
      roomCode,
    );
    reportCriticalErrorOnce(
      "room-missing",
      "Esta sala não foi encontrada no banco de dados. Pode ser que a criação da sala tenha falhado — volte pro Lobby e tente criar de novo.",
    );
    return;
  }

  joinCode = room.join_code;
  potTotal = room.pot;
  anteCollected = room.ante_collected;
  allowKick = room.allow_kick;
  dealerSeat = room.dealer_seat;
  currentTurnSeat = room.current_turn_seat;
  handState = room.hand_state;
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

  redirectToLobbyIfFinished();
}

function redirectToLobbyIfFinished() {
  if (gameStatus === "finished") {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    window.location.href = "lobby.html";
  }
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
        joinCode = payload.new.join_code;
        anteCollected = payload.new.ante_collected;
        allowKick = payload.new.allow_kick;
        dealerSeat = payload.new.dealer_seat;
        currentTurnSeat = payload.new.current_turn_seat;
        handState = payload.new.hand_state;
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
      },
    )
    .subscribe();
}

let tableSyncInterval = null;

function startTableSyncPolling() {
  if (tableSyncInterval) clearInterval(tableSyncInterval);
  tableSyncInterval = setInterval(async function () {
    if (document.hidden) return;
    if (isProcessingAction) return;
    try {
      await refreshRoomInfo();
      await refreshPlayers();
    } catch (e) {
      console.warn(
        "[GhostStackPoker] Polling de sincronização encontrou aviso leve:",
        e,
      );
    }
  }, 2500);
}

renderChipsUI();
renderHostUI();
refreshRoomInfo();
subscribeToRoom();
refreshPlayers();
startPresenceSystem();
startTableSyncPolling();
