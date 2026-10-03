-- Plan 5: two new message roles the web layer renders as cards, three Jev seats.
alter table messages drop constraint messages_role_check;
alter table messages add constraint messages_role_check
  check (role in ('user','agent','action','results','choices'));
alter table model_calls drop constraint model_calls_seat_check;
alter table model_calls add constraint model_calls_seat_check
  check (seat in ('front_desk','driver','scout','reviewer','monitor','titler','sim_user','intake','rerank','router'));
