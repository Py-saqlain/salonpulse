import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Scissors, ShieldCheck } from 'lucide-react';
import { ApiError } from './api';
import { useAuth } from './AuthContext';
import './auth.css';

export function AuthPage({ register }: { register: boolean }) {
  const auth = useAuth();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (auth.busy) return;
    setErrors({}); setError('');
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get('email') ?? '').trim().toLowerCase();
    const password = String(fields.get('password') ?? '');
    const full_name = String(fields.get('full_name') ?? '').trim();
    const business_name = String(fields.get('business_name') ?? '').trim();
    const invalid: Record<string, string> = {};
    if (register && !full_name) invalid.full_name = 'Enter your full name.';
    if (register && !business_name) invalid.business_name = 'Enter your salon name.';
    if (!password.trim()) invalid.password = 'Enter your password.';
    if (Object.keys(invalid).length) { setErrors(invalid); setError('Please check the highlighted fields.'); return; }
    try {
      if (register) await auth.register({ email, password, full_name, business_name });
      else await auth.login({ email, password });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
      if (reason instanceof ApiError) setErrors(reason.fields);
      // Never retain a submitted password after a failed attempt.
      const input = form.elements.namedItem('password');
      if (input instanceof HTMLInputElement) input.value = '';
    }
  }
  const field = (name: string, label: string, type: string, autoComplete: string, maxLength: number, minLength?: number) =>
    <label key={name}>{label}<input name={name} type={type} required maxLength={maxLength} minLength={minLength} autoComplete={autoComplete}
      aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `${name}-error` : name === 'password' && register ? 'password-help' : undefined} />
      {errors[name] && <span className="auth-field-error" id={`${name}-error`}>{errors[name]}</span>}</label>;
  return <main className="auth-shell">
    <section className="auth-intro"><a className="brand" href={register ? '#register' : '#login'}><span className="brand-icon"><Scissors aria-hidden="true" size={25} /></span>Salon<span className="brand-light">Pulse</span></a>
      <p className="eyebrow">MADE FOR YOUR EVERYDAY</p><h1>A little more flow.<br />A lot less busywork.</h1><p>Your team, your appointments, your salon.<br />One calm place to bring it all together.</p>
      <p className="auth-security"><ShieldCheck size={19} aria-hidden="true" /> Your business. Your workspace.</p></section>
    <section className="auth-panel" aria-labelledby="auth-title"><p className="eyebrow">{register ? 'START YOUR NEXT CHAPTER' : 'WELCOME BACK'}</p>
      <h2 id="auth-title">{register ? 'Create your salon account' : 'Log in to SalonPulse'}</h2><p className="auth-subtitle">{register ? 'Set up your business and owner account.' : 'A good day starts here. Let’s get you in.'}</p>
      {auth.message && <p role="status" className="auth-notice">{auth.message}</p>}
      {error && <div ref={alert} tabIndex={-1} role="alert" className="booking-error">{error}</div>}
      <form onSubmit={submit} className="auth-form" aria-busy={auth.busy}>
        <fieldset disabled={auth.busy}>{register && field('business_name', 'Salon name', 'text', 'organization', 200)}
          {register && field('full_name', 'Full name', 'text', 'name', 200)}
          {field('email', 'Email address', 'email', 'email', 320)}
          {field('password', 'Password', 'password', register ? 'new-password' : 'current-password', 128, register ? 12 : 1)}
          {register && <p id="password-help" className="field-help">Use 12–128 characters. Keep this password unique to SalonPulse.</p>}
          <button className="primary-button" type="submit">{auth.busy ? 'Please wait…' : register ? 'Create account' : 'Log in'}{!auth.busy && <ArrowRight size={18} aria-hidden="true" />}</button>
        </fieldset>
      </form>
      <p className="auth-switch">{register ? 'Already have an account?' : 'New to SalonPulse?'} {' '}<a aria-disabled={auth.busy} href={register ? '#login' : '#register'} onClick={event => { if (auth.busy) event.preventDefault(); }}>{register ? 'Log in' : 'Create an account'}</a></p>
      <p className="auth-footnote">For your privacy, this session ends when you refresh or close this page. Your business records stay saved securely.</p>
    </section>
  </main>;
}
