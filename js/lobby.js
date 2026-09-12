// ===========================================================
// GhostStackPoker — js/lobby.js
// Tela pós-partida: pódio, controles exclusivos do Host (doação,
// passar a coroa, expulsar) e o botão "Jogar Novamente", que reseta
// a sala inteira e puxa todo mundo de volta pra partida.html.
// ===========================================================

import { supabaseClient } from "./supabase.js";
import { loadSession, saveSession, clearSession } from "./session.js";
import { formatMoney } from "./chips.js";

const session = loadSession();

if (!session) {
  window.location.href = "home.html";
  throw new Error("Sem sessão ativa — redirecionando para o lobby.");
}

const roomCode = session.roomCode;
const myPlayerId = session.playerId;
const myName = session.playerName;

let isHost = session.isHost;
let playersCache = [];
let roomCache = null;
let selectedNewHostId = null;
let realtimeChannel = null;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------- RENDER ----------

function renderPodium() {
  const results = (roomCache && roomCache.final_results) || [];
  const winner = results.find(function (r) {
    return r.rank === 1;
  });
  const others = results
    .filter(function (r) {
      return r.rank !== 1;
    })
    .sort(function (a, b) {
      return a.rank - b.rank;
    });

  document.getElementById("winner-name").textContent = winner
    ? winner.name
    : "—";
  document.getElementById("winner-chips").textContent = formatMoney(
    winner ? winner.chips : 0,
  );
  document.getElementById("winner-rounds").textContent = roomCache
    ? roomCache.current_round
    : 0;

  const listEl = document.getElementById("ranking-list");
  listEl.innerHTML = "";

  others.forEach(function (r) {
    const stillInRoom = playersCache.some(function (p) {
      return p.id === r.player_id;
    });
    const showKick = isHost && roomCache && roomCache.allow_kick && stillInRoom;

    const card = document.createElement("div");
    card.className = "player-card flex items-center justify-between px-4 py-3";

    const kickButtonHtml = showKick
      ? '<button class="btn-kick-player" type="button" aria-label="Expulsar ' +
        escapeHtml(r.name) +
        '" title="Expulsar jogador" data-player-id="' +
        r.player_id +
        '" data-player-name="' +
        escapeHtml(r.name) +
        '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M13 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/>' +
        "</svg>" +
        "</button>"
      : "";

    card.innerHTML =
      '<div class="flex items-center gap-2">' +
      '<span class="rank-badge">' +
      r.rank +
      "</span>" +
      '<span class="text-cream font-body font-medium text-sm">' +
      escapeHtml(r.name) +
      (r.player_id === myPlayerId ? " (você)" : "") +
      (!stillInRoom
        ? ' <span class="text-cream/30 text-[10px]">(saiu)</span>'
        : "") +
      "</span>" +
      "</div>" +
      '<div class="flex items-center">' +
      '<p class="text-cream font-display text-base leading-none">' +
      formatMoney(r.chips) +
      "</p>" +
      kickButtonHtml +
      "</div>";

    listEl.appendChild(card);
  });

  document.querySelectorAll(".btn-kick-player").forEach(function (btn) {
    btn.addEventListener("click", function () {
      handleKickPlayer(btn.dataset.playerId, btn.dataset.playerName);
    });
  });
}

function renderHostPanel() {
  document.getElementById("host-panel").classList.toggle("hidden", !isHost);
  document.getElementById("btn-play-again").classList.toggle("hidden", !isHost);
  document
    .getElementById("waiting-host-message")
    .classList.toggle("hidden", isHost);

  if (roomCache) {
    document.getElementById("toggle-allow-donations-lobby").checked =
      !!roomCache.allow_donations;
  }
}

// ---------- AÇÕES DO HOST ----------

document
  .getElementById("toggle-allow-donations-lobby")
  .addEventListener("change", async function (event) {
    if (!isHost) return;
    await supabaseClient
      .from("rooms")
      .update({ allow_donations: event.target.checked })
      .eq("id", roomCode);
  });

async function handleKickPlayer(playerId, playerName) {
  if (!isHost) return;
  const confirmed = confirm(
    "Expulsar " + playerName + " da sala? Essa ação não pode ser desfeita.",
  );
  if (!confirmed) return;

  await supabaseClient.from("players").delete().eq("id", playerId);
}

document
  .getElementById("btn-play-again")
  .addEventListener("click", async function () {
    if (!isHost || !roomCache) return;

    const btn = document.getElementById("btn-play-again");
    btn.disabled = true;
    btn.textContent = "Preparando nova partida...";

    const startingChips = roomCache.starting_chips;

    // Reseta todo mundo que ainda está na sala pra um saldo novo.
    await Promise.all(
      playersCache.map(function (p) {
        return supabaseClient
          .from("players")
          .update({
            chips: startingChips,
            current_bet: 0,
            folded: false,
            is_eliminated: false,
            eliminated_at: null,
            needs_rebuy_approval: false,
          })
          .eq("id", p.id);
      }),
    );

    // Reseta a sala e volta o status pra 'in_progress' — é essa mudança
    // que o Realtime de todo mundo (inclusive de quem já está aqui no
    // Lobby) vai detectar pra "puxar" todos de volta pra partida.html.
    await supabaseClient
      .from("rooms")
      .update({
        game_status: "in_progress",
        current_round: 0,
        pot: 0,
        dealer_seat: null,
        current_turn_seat: null,
        side_pots: [],
        final_results: [],
        ante_collected: false,
      })
      .eq("id", roomCode);

    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    window.location.href = "partida.html";
  });

// ---------- PASSAR A COROA DE HOST ----------

const transferModal = document.getElementById("modal-transfer-host");
const transferList = document.getElementById("transfer-host-list");
const btnConfirmTransfer = document.getElementById("btn-confirm-transfer");

document
  .getElementById("btn-open-transfer-host")
  .addEventListener("click", function () {
    if (!isHost) return;

    selectedNewHostId = null;
    btnConfirmTransfer.disabled = true;

    const others = playersCache.filter(function (p) {
      return p.id !== myPlayerId;
    });
    transferList.innerHTML = "";

    if (others.length === 0) {
      transferList.innerHTML =
        '<p class="text-cream/40 text-xs font-body">Não há outro jogador na sala pra assumir o cargo.</p>';
    } else {
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
  });

document
  .getElementById("btn-cancel-transfer")
  .addEventListener("click", function () {
    transferModal.classList.add("hidden");
    transferModal.classList.remove("flex");
  });

btnConfirmTransfer.addEventListener("click", async function () {
  if (!selectedNewHostId) return;

  btnConfirmTransfer.disabled = true;
  btnConfirmTransfer.textContent = "Transferindo...";

  // Garante que só uma pessoa fica com is_host = true.
  await Promise.all(
    playersCache.map(function (p) {
      return supabaseClient
        .from("players")
        .update({ is_host: p.id === selectedNewHostId })
        .eq("id", p.id);
    }),
  );

  await supabaseClient
    .from("rooms")
    .update({ host_id: selectedNewHostId })
    .eq("id", roomCode);

  btnConfirmTransfer.disabled = false;
  btnConfirmTransfer.textContent = "Confirmar";
  transferModal.classList.add("hidden");
  transferModal.classList.remove("flex");

  // Eu mesmo deixei de ser Host — atualiza local e sessão.
  isHost = false;
  saveSession({
    roomCode: roomCode,
    playerId: myPlayerId,
    playerName: myName,
    isHost: false,
  });
  renderHostPanel();
});

// ---------- SAIR PRO LOBBY PRINCIPAL ----------

document
  .getElementById("link-leave-lobby")
  .addEventListener("click", function () {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
  });

// ---------- CARREGAMENTO E REALTIME ----------

async function refreshPlayers() {
  const { data, error } = await supabaseClient
    .from("players")
    .select("*")
    .eq("room_code", roomCode)
    .order("joined_at", { ascending: true });

  if (error || !data) return;

  const me = data.find(function (p) {
    return p.id === myPlayerId;
  });

  if (!me) {
    // Fui expulso enquanto estava no Lobby.
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    clearSession();
    alert("Você foi removido desta sala pelo host.");
    window.location.href = "home.html";
    return;
  }

  playersCache = data;

  if (me.is_host !== isHost) {
    isHost = me.is_host;
    saveSession({
      roomCode: roomCode,
      playerId: myPlayerId,
      playerName: myName,
      isHost: isHost,
    });
  }

  renderPodium();
  renderHostPanel();
}

async function refreshRoom() {
  const { data: room, error } = await supabaseClient
    .from("rooms")
    .select("*")
    .eq("id", roomCode)
    .single();

  if (error || !room) {
    window.location.href = "home.html";
    return;
  }

  roomCache = room;
  document.getElementById("room-code-display").textContent = room.join_code;

  // Se alguém abrir lobby.html com o jogo ainda rolando (link direto,
  // aba antiga), não faz sentido mostrar um pódio vazio — volta pra mesa.
  if (room.game_status !== "finished") {
    window.location.href = "partida.html";
    return;
  }

  renderPodium();
  renderHostPanel();
}

function subscribeToRoom() {
  realtimeChannel = supabaseClient
    .channel("lobby-" + roomCode)
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
        roomCache = payload.new;

        // O Host clicou em "Jogar Novamente" (em qualquer aba/dispositivo)
        // — todo mundo que estiver no Lobby é puxado de volta pra mesa.
        if (payload.new.game_status === "in_progress") {
          if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
          window.location.href = "partida.html";
          return;
        }

        renderPodium();
        renderHostPanel();
      },
    )
    .subscribe();
}

refreshRoom();
refreshPlayers();
subscribeToRoom();
