import React from 'react';
import TT from '../../i18n';
import { Chip, SectionLabel, Button, Select, Input } from '../../ds';
import st from './settings.module.css';
import type { AppState, User, Role } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: Role;
}
interface UsersSectionProps {
  state: AppState;
  ui: UiActions;
}

export function UsersSection({ state, ui }: UsersSectionProps) {
  const [users, setUsers] = React.useState<User[] | null>(null);
  const [form, setForm] = React.useState<UserForm | null>(null);
  // the user whose password is being reset, and the pending value
  const [reset, setReset] = React.useState<{ id: number; password: string } | null>(null);
  const reload = () =>
    ui.users
      .list()
      .then(setUsers)
      .catch(() => setUsers([]));
  React.useEffect(() => {
    reload();
  }, []);
  const submit = () => {
    if (!form) return;
    ui.users.create(form).then(() => {
      setForm(null);
      reload();
    });
  };
  const submitReset = () => {
    if (!reset?.password) return;
    ui.users.setPassword(reset.id, reset.password).then((ok) => {
      if (ok) setReset(null);
    });
  };
  return (
    <div className={st.section}>
      <SectionLabel
        style={{ marginBottom: 10 }}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setForm(form ? null : { name: '', email: '', password: '', role: 'employee' })}
          >
            {TT.t('+ user')}
          </Button>
        }
      >
        {TT.t('Users')}
      </SectionLabel>
      <div className={[st.row, st.rowHead, st.colsUsers].join(' ')}>
        {['name', 'Email', 'role'].map((header) => (
          <span key={header} className={st.th}>
            {TT.t(header)}
          </span>
        ))}
        <span></span>
        <span></span>
      </div>
      {(users || []).map((user) => (
        <React.Fragment key={user.id}>
          <div className={[st.row, st.colsUsers].join(' ')}>
            <span className={st.userName}>{user.name}</span>
            <span className={st.userEmail}>{user.email}</span>
            <Chip mono={true} tone={user.role === 'admin' ? 'green' : 'neutral'}>
              {TT.t(user.role)}
            </Chip>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReset(reset?.id === user.id ? null : { id: user.id, password: '' })}
            >
              {TT.t('password')}
            </Button>
            {user.id !== state.user.id ? (
              <button onClick={() => ui.users.remove(user.id).then(reload)} className={st.delBtn}>
                ×
              </button>
            ) : (
              <span></span>
            )}
          </div>
          {reset?.id === user.id && (
            <div
              className={st.resetRow}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') submitReset();
              }}
            >
              <Input
                type="password"
                autoComplete="new-password"
                autoFocus={true}
                placeholder={TT.t('New password for ') + user.email}
                value={reset.password}
                onChange={(e) => setReset({ ...reset, password: e.target.value })}
                className={st.small}
              />
              <Button variant="primary" size="sm" disabled={!reset.password} onClick={submitReset}>
                {TT.t('Set password')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setReset(null)}>
                {TT.t('cancel')}
              </Button>
            </div>
          )}
        </React.Fragment>
      ))}
      {form && (
        <div className={st.userForm}>
          <Input
            placeholder={TT.t('Name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={st.small}
          />
          <Input
            placeholder={TT.t('Email')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={st.small}
          />
          <Input
            placeholder={TT.t('Password')}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className={st.small}
          />
          <Select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            options={[
              { value: 'employee', label: TT.t('employee') },
              { value: 'admin', label: TT.t('admin') },
            ]}
            className={st.small}
          />
          <Button variant="primary" size="sm" disabled={!(form.name && form.email && form.password)} onClick={submit}>
            {TT.t('Create user')}
          </Button>
        </div>
      )}
    </div>
  );
}
