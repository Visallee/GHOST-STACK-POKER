-- ===========================================================
-- GhostStackPoker — schema-v5-game-rules.sql
-- Migração aditiva: condição de vitória, contagem de rodadas, pote(s)
-- secundário(s) [side pots], eliminação e rebuy/re-entry. Roda em cima
-- de schema.sql + v2 + v3 + v4, sem apagar nada. Cole no SQL Editor do
-- Supabase e clique em Run.
--
-- IMPORTANTE: esta migração só adiciona as colunas. A LÓGICA que as usa
-- (calcular side pots, detectar fim de jogo, aprovar rebuy) é da Fase 2.
-- Rodar isso agora não muda o comportamento do jogo ainda.
-- ===========================================================

-- ---------- Condição de vitória (definida pelo Host em host-config.html) ----------

alter table rooms add column if not exists win_condition text not null default 'elimination';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rooms_win_condition_check'
  ) then
    alter table rooms add constraint rooms_win_condition_check
      check (win_condition in ('elimination', 'round_limit'));
  end if;
end $$;

-- Só usado quando win_condition = 'round_limit'. Null enquanto o modo for 'elimination'.
alter table rooms add column if not exists round_limit integer;

-- Quantas rodadas (mãos completas, ou seja, quantas vezes "Entregar Pote"
-- foi clicado) já se passaram nesta sessão. Usado para comparar com
-- round_limit e decidir quando o jogo acabou.
alter table rooms add column if not exists current_round integer not null default 0;

-- Estado geral da sessão: 'in_progress' (jogando) ou 'finished' (condição
-- de vitória atingida — todo mundo deve ser redirecionado pro Lobby).
alter table rooms add column if not exists game_status text not null default 'in_progress';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rooms_game_status_check'
  ) then
    alter table rooms add constraint rooms_game_status_check
      check (game_status in ('in_progress', 'finished'));
  end if;
end $$;

-- ---------- Side pots (pote(s) secundário(s) de all-in) ----------

-- Snapshot dos potes calculados na última mão (o principal + quantos
-- secundários forem necessários). Formato:
-- [ { "amount": 80, "eligible_player_ids": ["uuid1","uuid2"] }, ... ]
-- Fica em branco ([]) fora de mãos com all-in parcial.
alter table rooms add column if not exists side_pots jsonb not null default '[]'::jsonb;

-- ---------- Resultado final (pra tela de Lobby pós-partida) ----------

-- Snapshot do pódio no momento em que o jogo terminou — guardado à parte
-- da tabela "players" porque jogadores podem sair/entrar de novo (rebuy
-- pra uma partida nova) depois que o jogo já acabou, o que mudaria os
-- dados "ao vivo". Formato:
-- [ { "player_id": "uuid", "name": "Ana", "chips": 2400, "rank": 1 }, ... ]
alter table rooms add column if not exists final_results jsonb not null default '[]'::jsonb;

-- ---------- Eliminação e Rebuy (re-entry) ----------

-- true quando o jogador chegou a 0 fichas (ou saiu no meio da rodada) e
-- ainda não foi autorizado pelo Host a voltar a jogar.
alter table players add column if not exists is_eliminated boolean not null default false;

-- true quando o jogador ELIMINADO pediu pra voltar e está esperando o
-- Host clicar em "autorizar" — separa "estou fora" de "já pedi pra voltar".
alter table players add column if not exists needs_rebuy_approval boolean not null default false;

-- Quando o jogador foi eliminado — usado para ordenar o pódio no modo
-- Mata-mata (quem durou mais tempo fica em posição melhor no ranking).
alter table players add column if not exists eliminated_at timestamptz;

-- ---------- Observação sobre salas/jogadores já existentes ----------
-- Salas criadas antes desta migração assumem 'elimination' como modo de
-- vitória por padrão (o valor default acima). Ninguém precisa reconfigurar
-- nada manualmente — mas se vocês querem o modo "Limite de Rodadas" numa
-- sala já criada, o Host vai precisar reabrir a configuração (isso será
-- resolvido na Fase 3, quando o host-config.html ganhar essa opção).
