// ===========================================================
// GhostStackPoker — js/host-config.js
// Lógica da tela exclusiva do Host: definir regras da sala e o saldo
// inicial antes de "abrir a mesa" pros convidados. Só quem criou a
// sala (isHost: true na sessão) chega aqui.
//
// MUDANÇA DE ARQUITETURA: a "Configuração Avançada de Fichas" (valor e
// quantidade de cada cor) foi REMOVIDA. O jogo não representa mais
// fichas físicas — só saldo em dinheiro (players.chips). O Host agora
// só define o Saldo Inicial; os botões de aposta na mesa têm valores
// fixos (ver js/chips.js).
// ===========================================================

import { supabaseClient } from './supabase.js';
import { loadSession, clearSession } from './session.js';


// ---------- 1. SESSÃO: só o Host pode estar aqui ----------

const session = loadSession();

if (!session || !session.isHost) {
  // Quem entrou como convidado (ou não tem sessão) não tem o que fazer
  // nesta tela — ela só existe entre "Criar Sala" e "Abrir Mesa".
  window.location.href = 'home.html';
  throw new Error('Acesso permitido apenas ao Host — redirecionando.');
}

const roomCode = session.roomCode;
const myPlayerId = session.playerId;


// ---------- 2. ELEMENTOS ----------

const slider = document.getElementById('slider-starting-chips');
const startingChipsDisplay = document.getElementById('starting-chips-display');
const btnOpenTable = document.getElementById('btn-open-table');


// ---------- 3. CONDIÇÃO DE VITÓRIA ----------

let winCondition = 'elimination'; // 'elimination' ou 'round_limit'

const btnWinElimination = document.getElementById('btn-win-elimination');
const btnWinRoundLimit = document.getElementById('btn-win-round-limit');
const roundLimitField = document.getElementById('round-limit-field');
const inputRoundLimit = document.getElementById('input-round-limit');
const roundLimitPreview = document.getElementById('round-limit-preview');

function setWinCondition(mode) {
  winCondition = mode;

  btnWinElimination.classList.toggle('is-selected', mode === 'elimination');
  btnWinElimination.classList.toggle('border-gold', mode === 'elimination');
  btnWinElimination.classList.toggle('border-cream/20', mode !== 'elimination');

  btnWinRoundLimit.classList.toggle('is-selected', mode === 'round_limit');
  btnWinRoundLimit.classList.toggle('border-gold', mode === 'round_limit');
  btnWinRoundLimit.classList.toggle('border-cream/20', mode !== 'round_limit');

  roundLimitField.classList.toggle('hidden', mode !== 'round_limit');
}

btnWinElimination.addEventListener('click', function () { setWinCondition('elimination'); });
btnWinRoundLimit.addEventListener('click', function () { setWinCondition('round_limit'); });

inputRoundLimit.addEventListener('input', function () {
  roundLimitPreview.textContent = inputRoundLimit.value || '—';
});


// ---------- 4. FUNÇÕES DE APOIO ----------

function formatMoney(value) {
  return value.toLocaleString('pt-BR');
}


// ---------- 5. SLIDER DE SALDO INICIAL (com botões -/+) ----------
//
// Bem mais simples agora: só ajusta o número. Não existe mais nenhuma
// "distribuição de fichas" pra recalcular junto — os botões de aposta
// na mesa têm valores fixos, o saldo inicial é só um número puro.

function setSliderValue(value) {
  const clamped = Math.min(5000, Math.max(500, value));
  slider.value = clamped;
  startingChipsDisplay.textContent = formatMoney(clamped);
}

slider.addEventListener('input', function () {
  setSliderValue(Number(slider.value));
});

document.getElementById('btn-chips-minus').addEventListener('click', function () {
  setSliderValue(Number(slider.value) - 100);
});

document.getElementById('btn-chips-plus').addEventListener('click', function () {
  setSliderValue(Number(slider.value) + 100);
});


// ---------- 6. ABRIR MESA ----------

function showConfigError(message) {
  const el = document.getElementById('config-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

btnOpenTable.addEventListener('click', async function () {
  const startingChips = Number(slider.value);
  const allowKick = document.getElementById('toggle-allow-kick').checked;
  const allowDonations = document.getElementById('toggle-allow-donations').checked;
  const anteAmount = Math.max(0, Number(document.getElementById('input-ante').value) || 0);
  const maxPlayers = Math.min(20, Math.max(2, Number(document.getElementById('input-max-players').value) || 8));
  const roundLimit = winCondition === 'round_limit'
    ? Math.max(1, Number(inputRoundLimit.value) || 10)
    : null;

  btnOpenTable.disabled = true;
  btnOpenTable.textContent = 'Abrindo mesa...';

  // Salva as regras da sala. Note que "chip_values"/"chip_counts" não
  // são mais enviados — essas colunas continuam existindo no banco
  // (inofensivas, sem uso), mas o jogo não lê mais elas.
  const { error: roomError } = await supabaseClient
    .from('rooms')
    .update({
      status: 'open',
      host_id: myPlayerId,
      allow_kick: allowKick,
      allow_donations: allowDonations,
      starting_chips: startingChips,
      max_players: maxPlayers,
      ante_amount: anteAmount,
      win_condition: winCondition,
      round_limit: roundLimit
    })
    .eq('id', roomCode);

  if (roomError) {
    btnOpenTable.disabled = false;
    btnOpenTable.textContent = 'Abrir Mesa';
    showConfigError('Não foi possível salvar as configurações: ' + roomError.message);
    return;
  }

  // O host também é jogador — garante que o saldo dele já nasce
  // com o valor definido aqui (e não com o 1000 padrão do cadastro).
  const { error: playerError } = await supabaseClient
    .from('players')
    .update({ chips: startingChips, is_host: true })
    .eq('id', myPlayerId);

  if (playerError) {
    btnOpenTable.disabled = false;
    btnOpenTable.textContent = 'Abrir Mesa';
    showConfigError('Não foi possível atualizar seu saldo: ' + playerError.message);
    return;
  }

  window.location.href = 'partida.html';
});


// ---------- 7. CANCELAR E VOLTAR ----------

document.getElementById('btn-cancel-room').addEventListener('click', async function () {
  const btn = document.getElementById('btn-cancel-room');
  btn.textContent = 'Cancelando...';

  // Como a sala ainda está em 'configuring', ninguém mais entrou nela —
  // é seguro apagar tudo e voltar pro lobby.
  await supabaseClient.from('players').delete().eq('id', myPlayerId);
  await supabaseClient.from('rooms').delete().eq('id', roomCode);

  clearSession();
  window.location.href = 'home.html';
});


// ---------- 8. INICIALIZAÇÃO ----------

document.getElementById('room-code-display').textContent = roomCode;
setSliderValue(1000);
