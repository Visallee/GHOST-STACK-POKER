-- ===========================================================
-- GhostStackPoker — schema-v7-betting-engine.sql
-- Fase 4 do Plano Mestre: motor de turnos + ciclo obrigatório de
-- "Cobrar Antes". Roda em cima de tudo que já existe, sem apagar
-- nada. Cole no SQL Editor do Supabase e clique em Run.
-- ===========================================================

-- ---------- Estado explícito da mão/rodada ----------
-- Substitui a lógica antiga que inferia "tem mão em andamento?" só
-- olhando se current_turn_seat era null. Agora existe um estado
-- nomeado, evitando os bugs de "ninguém tem a vez" / "os dois acham
-- que é a vez do outro".
--
-- Valores: 'no_hand' | 'waiting_for_ante' | 'betting' | 'round_complete'
alter table rooms add column if not exists hand_state text not null default 'no_hand';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rooms_hand_state_check'
  ) then
    alter table rooms add constraint rooms_hand_state_check
      check (hand_state in ('no_hand', 'waiting_for_ante', 'betting', 'round_complete'));
  end if;
end $$;

-- ---------- Rastreamento de quem já agiu nesta rodada de apostas ----------
-- Fundamental pro motor saber a diferença entre "todo mundo está com o
-- mesmo valor apostado por causa do Ante" (ninguém agiu de verdade
-- ainda) e "todo mundo respondeu de verdade e igualou" (a rodada pode
-- fechar). Reseta a cada mão nova, e também sempre que alguém AUMENTA
-- a aposta (reabre a decisão pra quem já tinha agido).
alter table players add column if not exists has_acted_this_round boolean not null default false;

-- ---------- Flag explícita de All-in ----------
-- Antes, "está all-in" era só inferido de chips = 0. Isso funciona pra
-- decidir turnos, mas não distingue "está all-in nesta mão" de "foi
-- eliminado depois da mão anterior" — são conceitos diferentes (um
-- jogador all-in ainda pode ganhar a mão e voltar a ter fichas).
alter table players add column if not exists is_all_in boolean not null default false;

-- ---------- Observação sobre salas/jogadores já existentes ----------
-- Salas em andamento no momento desta migração vão assumir hand_state
-- = 'no_hand' (o padrão) — se alguém estiver no meio de uma mão bem
-- nessa hora, o mais simples é o Host clicar em "Iniciar Mão" de novo
-- depois da migração. Isso só afeta quem estava jogando EXATAMENTE no
-- momento de rodar este script.
