// ===========================================================
// GhostStackPoker — js/home.js
// Lógica da Tela 1 (Lobby): criar sala ou entrar numa sala existente.
// Ao ter sucesso, salva a "sessão" do jogador e navega pra partida.html.
// ===========================================================

import { supabaseClient } from './supabase.js';
import { saveSession } from './session.js';
import { generateRoomCode } from './room-code.js';

// ---------- Funções de apoio ----------

function showHomeError(message) {
  const errorEl = document.getElementById('home-error');
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideHomeError() {
  document.getElementById('home-error').classList.add('hidden');
}

function setButtonLoading(button, loading, loadingText) {
  button.disabled = loading;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.textContent = loading ? loadingText : button.dataset.originalText;
}

// Depois de criar/entrar com sucesso, guarda os dados do jogador
// e manda ele pra próxima tela.
function goToPage(session, page) {
  saveSession(session);
  window.location.href = page;
}

// Assento fixo (1, 2, 3...) atribuído ao entrar na sala — usado pelo
// controle de turnos em partida.js. Independe da ordem de chegada
// (joined_at): uma vez atribuído, o número do assento nunca muda,
// mesmo que jogadores anteriores saiam da mesa.
async function getNextSeatNumber(roomId) {
  const { data } = await supabaseClient
    .from('players')
    .select('seat_number')
    .eq('room_code', roomId);

  const usedSeats = (data || [])
    .map(function (p) { return p.seat_number; })
    .filter(function (n) { return typeof n === 'number'; });

  return usedSeats.length === 0 ? 1 : Math.max.apply(null, usedSeats) + 1;
}


// ---------- Criar sala ----------

document.getElementById('btn-create-room').addEventListener('click', async function () {
  hideHomeError();
  const name = document.getElementById('input-create-name').value.trim();
  if (!name) {
    showHomeError('Digite seu nome para criar a sala.');
    return;
  }

  const btn = document.getElementById('btn-create-room');
  setButtonLoading(btn, true, 'Criando sala...');

  const newCode = generateRoomCode();

  const { error: roomError } = await supabaseClient
    .from('rooms')
    .insert({ id: newCode, join_code: newCode, pot: 0 });

  if (roomError) {
    setButtonLoading(btn, false);
    showHomeError('Não foi possível criar a sala: ' + roomError.message);
    return;
  }

  // O host é sempre o primeiro a se sentar — assento 1.
  const { data: playerRow, error: playerError } = await supabaseClient
    .from('players')
    .insert({ room_code: newCode, name: name, chips: 1000, is_host: true, seat_number: 1 })
    .select()
    .single();

  setButtonLoading(btn, false);

  if (playerError) {
    showHomeError('Não foi possível entrar na sala: ' + playerError.message);
    return;
  }

  goToPage({
    roomCode: newCode,
    playerId: playerRow.id,
    playerName: name,
    isHost: true
  }, 'host-config.html');
});


// ---------- Entrar em sala existente ----------

document.getElementById('btn-join-room').addEventListener('click', async function () {
  hideHomeError();
  const name = document.getElementById('input-join-name').value.trim();
  const code = document.getElementById('input-join-code').value.trim().toUpperCase();

  if (!name) {
    showHomeError('Digite seu nome para entrar na sala.');
    return;
  }
  if (!code) {
    showHomeError('Digite o código da sala.');
    return;
  }

  const btn = document.getElementById('btn-join-room');
  setButtonLoading(btn, true, 'Entrando...');

  const { data: roomRow, error: roomError } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('join_code', code)
    .maybeSingle();

  if (roomError || !roomRow) {
    setButtonLoading(btn, false);
    showHomeError('Sala não encontrada. Confira o código com quem criou a sala.');
    return;
  }

  if (roomRow.status !== 'open') {
    setButtonLoading(btn, false);
    showHomeError('Essa sala ainda está sendo configurada pelo host. Aguarde ele abrir a mesa.');
    return;
  }

  const seatNumber = await getNextSeatNumber(roomRow.id);

  const { data: playerRow, error: playerError } = await supabaseClient
    .from('players')
    .insert({ room_code: roomRow.id, name: name, chips: roomRow.starting_chips, is_host: false, seat_number: seatNumber })
    .select()
    .single();

  setButtonLoading(btn, false);

  if (playerError) {
    showHomeError('Não foi possível entrar na sala: ' + playerError.message);
    return;
  }

  goToPage({
    roomCode: roomRow.id,
    playerId: playerRow.id,
    playerName: name,
    isHost: false
  }, 'partida.html');
});
