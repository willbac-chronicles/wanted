-- =====================================================================
-- Wanted — test de bout en bout côté base (éditeur SQL Supabase).
-- Simule un organisateur et 3 joueurs, puis efface toutes ses traces.
-- À lancer uniquement quand aucune vraie partie n'est en cours.
-- =====================================================================

create temp table if not exists _report(n serial, test text, ok boolean, detail text);
truncate _report;

do $$
declare
  u_org uuid := gen_random_uuid();
  u uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  pid uuid[] := '{}';
  r json;
  st json;
  t_id uuid; h_id uuid; x_id uuid;
  v_code text;
  i int;
  v_err text;
begin
  if (select status from public.games where id = 1) <> 'accueil'
     or exists (select 1 from public.assignments) then
    raise exception 'Une partie est en cours : test annulé';
  end if;

  -- Organisateur
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.claim_organizer((select org_code from public.games where id = 1));
  insert into _report(test, ok) values ('claim_organizer', public._is_org());

  begin
    perform public.claim_organizer('MAUVAIS');
    insert into _report(test, ok) values ('code organisateur faux refusé', false);
  exception when others then
    insert into _report(test, ok) values ('code organisateur faux refusé', true);
  end;

  for i in 1..3 loop
    r := public.org_create_player('__test_' || i);
    pid := pid || (r->>'id')::uuid;
  end loop;
  insert into _report(test, ok, detail) values ('3 joueurs créés', array_length(pid,1) = 3, null);

  -- Chaque joueur se connecte avec son code d'accès
  for i in 1..3 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
    perform public.claim_player(lower((select access_code from public.players where id = pid[i])));
  end loop;
  insert into _report(test, ok) values ('connexion des 3 joueurs (code en minuscules)',
    (select count(*) from public.devices where auth_uid = any(u) and player_id = any(pid)) = 3);

  -- Droits : un joueur ne peut pas lire les tables directement
  begin
    execute 'set local role authenticated';
    perform count(*) from public.players;
    execute 'reset role';
    insert into _report(test, ok) values ('lecture directe des tables bloquée', false);
  exception when insufficient_privilege then
    execute 'reset role';
    insert into _report(test, ok) values ('lecture directe des tables bloquée', true);
  end;

  -- Un joueur ne peut pas utiliser les fonctions organisateur
  begin
    perform public.org_reset();
    insert into _report(test, ok) values ('fonctions org refusées au joueur', false);
  exception when others then
    insert into _report(test, ok) values ('fonctions org refusées au joueur', true);
  end;

  -- Dispersion : pas de cible visible
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_start_dispersion(1);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('dispersion : aucune cible',
    st->'game'->>'status' = 'dispersion' and json_typeof(st->'target') = 'null', st->'game'->>'status');

  -- START forcé : tirage en boucle
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_draw_now();
  insert into _report(test, ok, detail) values ('tirage en boucle : 1 cible et 1 chasseur chacun',
    (select count(*) from public.assignments where closed_at is null and hunter_id = any(pid)) = 3
    and (select count(distinct target_id) from public.assignments where closed_at is null and hunter_id = any(pid)) = 3
    and not exists (select 1 from public.assignments where hunter_id = target_id),
    (select status from public.games where id = 1));

  -- Joueur 1 voit sa cible
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  select target_id into t_id from public.assignments where hunter_id = pid[1] and closed_at is null;
  insert into _report(test, ok, detail) values ('get_my_state renvoie la cible',
    st->'target'->>'pseudo' = (select pseudo from public.players where id = t_id), st->'target'->>'pseudo');

  -- Anti-essais : le joueur 2 se trompe 3 fois
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  select target_id into x_id from public.assignments where hunter_id = pid[2] and closed_at is null;
  v_code := lpad(((select capture_code from public.players where id = x_id)::int + 1) % 10000 || '', 4, '0');
  r := public.submit_capture(v_code);
  r := public.submit_capture(v_code);
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('3 codes faux : blocage', (r->>'locked_until') is not null, r::text);
  r := public.submit_capture((select capture_code from public.players where id = x_id));
  insert into _report(test, ok, detail) values ('bloqué même avec le bon code', r->>'reason' = 'locked', r->>'reason');

  -- Capture réussie par le joueur 1
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  v_code := (select capture_code from public.players where id = t_id);
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('capture réussie', (r->>'ok')::boolean, r::text);
  insert into _report(test, ok, detail) values ('scores +3 / −2',
    (select sum(points) from public.score_events where player_id = pid[1]) = 3
    and (select sum(points) from public.score_events where player_id = t_id) = -2, null);
  insert into _report(test, ok) values ('nouveau code et immunité pour la cible',
    (select capture_code <> v_code and immune_until > now() from public.players where id = t_id));
  insert into _report(test, ok, detail) values ('nouvelle cible du chasseur ≠ lui-même et ≠ cible trouvée',
    (select target_id not in (pid[1], t_id) from public.assignments where hunter_id = pid[1] and closed_at is null),
    (select p.pseudo from public.assignments a join public.players p on p.id = a.target_id
      where a.hunter_id = pid[1] and a.closed_at is null));

  -- Double envoi : même code une 2e fois
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('double envoi refusé', not (r->>'ok')::boolean, r->>'reason');

  -- Immunité : l'organisateur fait chasser la cible immunisée
  select id into h_id from public.players where id = any(pid) and id not in (pid[1], t_id);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_reassign(h_id, t_id);
  delete from public.code_attempts where hunter_id = h_id; -- au cas où ce joueur serait celui qui est bloqué
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, h_id)], 'role', 'authenticated')::text, true);
  r := public.submit_capture((select capture_code from public.players where id = t_id));
  insert into _report(test, ok, detail) values ('cible immunisée protégée', r->>'reason' = 'immune', r->>'reason');

  -- Plusieurs chasseurs sur la même cible : tous réattribués
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  update public.players set immune_until = null where id = t_id;
  perform public.org_reassign(pid[1], t_id);
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, h_id)], 'role', 'authenticated')::text, true);
  r := public.submit_capture((select capture_code from public.players where id = t_id));
  insert into _report(test, ok, detail) values ('2e capture : les 2 chasseurs de la cible sont réattribués',
    (r->>'ok')::boolean
    and not exists (select 1 from public.assignments where target_id = t_id and closed_at is null),
    r::text);

  -- Lecture du classement et de la vue organisateur
  st := public.get_leaderboard();
  insert into _report(test, ok, detail) values ('classement', json_array_length(st) >= 3, st::text);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  st := public.org_get_overview();
  insert into _report(test, ok) values ('vue organisateur', json_array_length(st->'players') >= 3);

  -- Annulation de capture
  perform public.org_cancel_capture((select max(id) from public.captures));
  insert into _report(test, ok) values ('annulation de capture rend les points',
    (select sum(points) from public.score_events where player_id = t_id) = -2);

  -- Fin de manche
  perform public.org_end_round();
  insert into _report(test, ok, detail) values ('fin de manche → regroupement',
    (select status from public.games where id = 1) = 'regroupement'
    and not exists (select 1 from public.assignments where closed_at is null),
    (select status from public.games where id = 1));

  -- Nettoyage
  perform public.org_reset();
  delete from public.players where id = any(pid);
  delete from public.devices where auth_uid = any(u) or auth_uid = u_org;
  delete from public.event_log where true;
  insert into _report(test, ok) values ('nettoyage', not exists (select 1 from public.players where pseudo like '\_\_test\_%'));
exception when others then
  get stacked diagnostics v_err = pg_exception_context;
  insert into _report(test, ok, detail) values ('ERREUR : ' || sqlerrm, false, v_err);
  -- Les modifications du bloc sont annulées automatiquement en cas d'erreur.
end $$;

select n, test, case when ok then 'OK' else 'ÉCHEC' end as resultat, left(detail, 200) as detail
  from _report order by n;
