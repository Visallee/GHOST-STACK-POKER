// ===========================================================
// GhostStackPoker — js/home.js
// ===========================================================

import { supabaseClient } from "./supabase.js";
import { saveSession } from "./session.js";
import { generateRoomCode } from "./room-code.js";

function showHomeError(message) {
  const errorEl = document.getElementById("home-error");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function hideHomeError() {
  document.getElementById("home-error").classList.add("hidden");
}

function setButtonLoading(button, loading, loadingText) {
  button.disabled = loading;
  button.dataset.originalText =
    button.dataset.originalText || button.textContent;
  button.textContent = loading ? loadingText : button.dataset.originalText;
}

function goToPage(session, page) {
  saveSession(session);
  window.location.href = page;
}

// ---------- Criar sala ----------
document
  .getElementById("btn-create-room")
  .addEventListener("click", async function () {
    hideHomeError();
    const name = document.getElementById("input-create-name").value.trim();
    if (!name) {
      showHomeError("Digite seu nome para criar a sala.");
      return;
    }

    const btn = document.getElementById("btn-create-room");
    setButtonLoading(btn, true, "Criando sala...");

    const newCode = generateRoomCode();

    const { error: roomError } = await supabaseClient
      .from("rooms")
      .insert({
        id: newCode,
        join_code: newCode,
        pot: 0,
        hand_state: "no_hand",
      });

    if (roomError) {
      setButtonLoading(btn, false);
      showHomeError("Não foi possível criar a sala: " + roomError.message);
      return;
    }

    const { data: playerRow, error: playerError } = await supabaseClient.rpc(
      "join_room_secure",
      {
        p_room_code: newCode,
        p_name: name,
        p_chips: 1000,
        p_is_host: true,
        p_sitting_out: false,
      },
    );

    setButtonLoading(btn, false);

    if (playerError) {
      showHomeError("Não foi possível entrar na sala: " + playerError.message);
      return;
    }

    goToPage(
      {
        roomCode: newCode,
        playerId: playerRow.id,
        playerName: name,
        isHost: true,
      },
      "host-config.html",
    );
  });

// ---------- Entrar em sala existente ----------
document
  .getElementById("btn-join-room")
  .addEventListener("click", async function () {
    hideHomeError();
    const name = document.getElementById("input-join-name").value.trim();
    const code = document
      .getElementById("input-join-code")
      .value.trim()
      .toUpperCase();

    if (!name) {
      showHomeError("Digite seu nome para entrar na sala.");
      return;
    }
    if (!code) {
      showHomeError("Digite o código da sala.");
      return;
    }

    const btn = document.getElementById("btn-join-room");
    setButtonLoading(btn, true, "Entrando...");

    const { data: roomRow, error: roomError } = await supabaseClient
      .from("rooms")
      .select("*")
      .eq("join_code", code)
      .maybeSingle();

    if (roomError || !roomRow) {
      setButtonLoading(btn, false);
      showHomeError(
        "Sala não encontrada. Confira o código com quem criou a sala.",
      );
      return;
    }

    if (roomRow.status !== "open") {
      setButtonLoading(btn, false);
      showHomeError(
        "Essa sala ainda está sendo configurada pelo host. Aguarde ele abrir a mesa.",
      );
      return;
    }

    // Se houver mão em andamento, o novo jogador entra em quarentena de espera
    const isMidHand = roomRow.hand_state !== "no_hand";

    const { data: playerRow, error: playerError } = await supabaseClient.rpc(
      "join_room_secure",
      {
        p_room_code: roomRow.id,
        p_name: name,
        p_chips: roomRow.starting_chips,
        p_is_host: false,
        p_sitting_out: isMidHand,
      },
    );

    setButtonLoading(btn, false);

    if (playerError) {
      // Apanha erros de concorrência ou constraint da base de dados
      showHomeError(
        "Conflito de entrada na mesa. Tente novamente: " + playerError.message,
      );
      return;
    }

    goToPage(
      {
        roomCode: roomRow.id,
        playerId: playerRow.id,
        playerName: name,
        isHost: false,
      },
      "partida.html",
    );
  });
