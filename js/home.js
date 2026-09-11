// ===========================================================
// GhostStackPoker — js/home.js
// Lógica da Tela 1 (Lobby): criar sala ou entrar numa sala existente.
// Ao ter sucesso, salva a "sessão" do jogador e navega pra partida.html.
// ===========================================================

import { supabaseClient } from "./supabase.js";
import { saveSession } from "./session.js";

// ---------- Funções de apoio ----------

// Gera um código de sala simples de 6 caracteres (letras + números).
// Sem O/0/I/1 pra evitar confusão na hora de digitar.
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

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

// Depois de criar/entrar com sucesso, guarda os dados do jogador
// e manda ele pra tela da mesa.
function goToPartida(session) {
  saveSession(session);
  window.location.href = "partida.html";
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
      .insert({ id: newCode, pot: 0 });

    if (roomError) {
      setButtonLoading(btn, false);
      showHomeError("Não foi possível criar a sala: " + roomError.message);
      return;
    }

    const { data: playerRow, error: playerError } = await supabaseClient
      .from("players")
      .insert({ room_code: newCode, name: name, chips: 1000, is_host: true })
      .select()
      .single();

    setButtonLoading(btn, false);

    if (playerError) {
      showHomeError("Não foi possível entrar na sala: " + playerError.message);
      return;
    }

    goToPartida({
      roomCode: newCode,
      playerId: playerRow.id,
      playerName: name,
      isHost: true,
    });
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
      .eq("id", code)
      .maybeSingle();

    if (roomError || !roomRow) {
      setButtonLoading(btn, false);
      showHomeError(
        "Sala não encontrada. Confira o código com quem criou a sala.",
      );
      return;
    }

    const { data: playerRow, error: playerError } = await supabaseClient
      .from("players")
      .insert({ room_code: code, name: name, chips: 1000, is_host: false })
      .select()
      .single();

    setButtonLoading(btn, false);

    if (playerError) {
      showHomeError("Não foi possível entrar na sala: " + playerError.message);
      return;
    }

    goToPartida({
      roomCode: code,
      playerId: playerRow.id,
      playerName: name,
      isHost: false,
    });
  });
