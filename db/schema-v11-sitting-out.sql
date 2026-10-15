-- ===========================================================
-- GhostStackPoker — schema-v11-sitting-out.sql
-- Fase 7.6: Entrada Mid-Game Segura + Anti-Colisão de Assento
-- ===========================================================

-- 1. Flag de Quarentena: Impede que o jogador interfira na mão atual.
alter table players add column if not exists sitting_out boolean not null default false;

-- 2. Anti-Colisão: Impede fisicamente dois assentos iguais na mesma sala.
create unique index if not exists players_room_seat_unique_idx on players (room_code, seat_number);

-- 3. Inserção Segura Atómica (RPC): 
-- Executa com permissões de administrador (security definer) e bloqueia a sala 
-- durante o cálculo para evitar que dois jogadores entrem no mesmo milissegundo.
create or replace function join_room_secure(
  p_room_code text,
  p_name text
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_next_seat integer;
  v_new_player record;
  v_room record;
  v_is_host boolean;
  v_sitting_out boolean;
begin
  -- Bloqueia a sala para impedir conflitos
  select * into v_room from rooms where id = p_room_code for update;
  
  if not found then
    raise exception 'Sala não encontrada.';
  end if;

  if v_room.status != 'open' then
    raise exception 'A sala não está aberta para novos jogadores.';
  end if;

  select coalesce(max(seat_number), 0) + 1 into v_next_seat
  from players
  where room_code = p_room_code;

  -- Primeiro a entrar é Host automático, os outros não.
  if v_next_seat = 1 then
     v_is_host := true;
  else
     v_is_host := false;
  end if;

  -- Se a mão começou, o jogador fica de fora obrigatoriamente
  if v_room.hand_state != 'no_hand' then
     v_sitting_out := true;
  else
     v_sitting_out := false;
  end if;

  -- O servidor define o saldo inicial e o status, o cliente não pode trapacear
  insert into players (room_code, name, chips, is_host, seat_number, sitting_out)
  values (p_room_code, p_name, v_room.starting_chips, v_is_host, v_next_seat, v_sitting_out)
  returning * into v_new_player;

  return row_to_json(v_new_player);
end;
$$;