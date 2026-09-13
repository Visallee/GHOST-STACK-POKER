// ===========================================================
// GhostStackPoker — js/host-config.js
// Lógica da tela exclusiva do Host: definir regras da sala, saldo
// inicial e a distribuição de fichas antes de "abrir a mesa" pros
// convidados. Só quem criou a sala (isHost: true na sessão) chega aqui.
// ===========================================================

import { supabaseClient } from './supabase.js';
import { loadSession, saveSession, clearSession } from './session.js';
import { chipValues as defaultChipValues, initialChipCounts as defaultChipCounts } from './chips.js';


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


// ---------- 2. ESTADO ----------

// true assim que o host mexer manualmente em qualquer campo de
// "Configurações avançadas" — a partir daí o slider para de
// sobrescrever os valores automaticamente.
let advancedManuallyEdited = false;


// ---------- 3. ELEMENTOS ----------

const slider = document.getElementById('slider-starting-chips');
const startingChipsDisplay = document.getElementById('starting-chips-display');
const advancedTotalDisplay = document.getElementById('advanced-total-display');
const advancedWarning = document.getElementById('advanced-warning');
const btnOpenTable = document.getElementById('btn-open-table');

const colors = ['preta', 'azul', 'vermelha', 'verde', 'branca', 'amarela'];

// ---------- CONDIÇÃO DE VITÓRIA ----------

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

function getValueInput(color) {
  return document.querySelector(`.chip-config-value[data-color="${color}"]`);
}
function getCountInput(color) {
  return document.querySelector(`.chip-config-count[data-color="${color}"]`);
}

// Lê os 12 campos (6 valores + 6 quantidades) do formulário.
function readAdvancedConfig() {
  const values = {};
  const counts = {};
  colors.forEach(function (color) {
    values[color] = Math.max(1, Number(getValueInput(color).value) || 0);
    counts[color] = Math.max(0, Number(getCountInput(color).value) || 0);
  });
  return { values, counts };
}

// Dado um total-alvo, recalcula a QUANTIDADE de cada ficha proporcional
// à distribuição oficial (mantendo o "valor" de cada cor como está),
// sempre batendo exatamente no total (a ficha preta absorve o resto).
function recalcCountsForTotal(total) {
  const ratio = total / 1000;
  const counts = {};
  let runningTotal = 0;

  // IMPORTANTE: usa Math.floor (nunca "arredonda pra cima") em cada
  // denominação maior. Isso GARANTE que a soma parcial nunca ultrapassa
  // o total pedido — o bug antigo usava Math.round em cada uma
  // independentemente, e o excesso acumulado (ex: 500 virava 550) nunca
  // era corrigido, porque a ficha preta só conseguia SOMAR, nunca tirar
  // o que já tinha "estourado" antes dela.
  ['amarela', 'branca', 'verde', 'vermelha', 'azul'].forEach(function (color) {
    const value = Number(getValueInput(color).value) || defaultChipValues[color];
    const count = Math.max(0, Math.floor(defaultChipCounts[color] * ratio));
    counts[color] = count;
    runningTotal += count * value;
  });

  // A ficha preta (a menor) sempre absorve o restante exato — com o
  // floor acima, "remaining" nunca fica negativo.
  const pretaValue = Number(getValueInput('preta').value) || defaultChipValues.preta;
  const remaining = total - runningTotal;
  counts.preta = pretaValue > 0 ? Math.max(0, Math.round(remaining / pretaValue)) : 0;

  return counts;
}

// Recalcula o total configurado, valida contra o saldo do slider e
// habilita/desabilita o botão "Abrir Mesa" de acordo.
function updateAdvancedTotalAndValidation() {
  const { values, counts } = readAdvancedConfig();
  let total = 0;
  colors.forEach(function (color) { total += values[color] * counts[color]; });

  advancedTotalDisplay.textContent = formatMoney(total);

  const target = Number(slider.value);
  const matches = total === target;

  advancedTotalDisplay.classList.toggle('text-gold', matches);
  advancedTotalDisplay.classList.toggle('text-burgundy', !matches);

  if (!matches) {
    advancedWarning.textContent =
      'O total configurado (' + formatMoney(total) + ') não bate com o saldo inicial escolhido (' + formatMoney(target) + '). Ajuste os valores ou clique em "Recalcular automaticamente".';
    advancedWarning.classList.remove('hidden');
  } else {
    advancedWarning.classList.add('hidden');
  }

  btnOpenTable.disabled = !matches;
  return { values, counts, total, matches };
}

// Aplica no formulário uma distribuição de quantidades já calculada.
function applyCounts(counts) {
  colors.forEach(function (color) {
    getCountInput(color).value = counts[color];
  });
}


// ---------- 5. SLIDER DE SALDO INICIAL (com botões -/+) ----------

function setSliderValue(value) {
  const clamped = Math.min(5000, Math.max(500, value));
  slider.value = clamped;
  startingChipsDisplay.textContent = formatMoney(clamped);

  if (!advancedManuallyEdited) {
    applyCounts(recalcCountsForTotal(clamped));
  }
  updateAdvancedTotalAndValidation();
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


// ---------- 6. CONFIGURAÇÕES AVANÇADAS (edição manual) ----------

document.querySelectorAll('.chip-config-value, .chip-config-count').forEach(function (input) {
  input.addEventListener('input', function () {
    advancedManuallyEdited = true;
    updateAdvancedTotalAndValidation();
  });
});

document.getElementById('btn-recalc-advanced').addEventListener('click', function () {
  advancedManuallyEdited = false;
  applyCounts(recalcCountsForTotal(Number(slider.value)));
  updateAdvancedTotalAndValidation();
});


// ---------- 7. ACORDEÃO ----------

const advancedBody = document.getElementById('advanced-body');
const advancedChevron = document.getElementById('advanced-chevron');

document.getElementById('btn-toggle-advanced').addEventListener('click', function () {
  advancedBody.classList.toggle('is-open');
  advancedChevron.classList.toggle('is-open');
});


// ---------- 8. ABRIR MESA ----------

function showConfigError(message) {
  const el = document.getElementById('config-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

btnOpenTable.addEventListener('click', async function () {
  const { values, counts, total, matches } = updateAdvancedTotalAndValidation();
  if (!matches) return; // botão já deveria estar desabilitado, mas confere de novo por segurança

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

  // Salva todas as regras da sala.
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
      chip_values: values,
      chip_counts: counts,
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


// ---------- 9. CANCELAR E VOLTAR ----------

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


// ---------- 10. INICIALIZAÇÃO ----------

document.getElementById('room-code-display').textContent = roomCode;
setSliderValue(1000);
