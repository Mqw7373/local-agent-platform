'use client';

import { useCallback, useEffect, useState } from 'react';

type Service = {
  id: string;
  eyebrow: string;
  name: string;
  description: string;
  studioUrl: string;
  apiUrl: string;
  port: string;
  accent: string;
  workflows: string[];
  boundary: string;
};

type ServiceState = {
  online: boolean;
  workflowCount: number;
  checkedAt?: Date;
};

const services: Service[] = [
  {
    id: 'coding-mastra',
    eyebrow: 'Development system · Mastra',
    name: 'Coding / Mastra',
    description: 'Visual Mastra orchestration over the shared contract-first Coding Agent runtime.',
    studioUrl: 'http://localhost:4113/workflows',
    apiUrl: 'http://localhost:4113/api/workflows',
    port: ':4113',
    accent: '#d9ff62',
    workflows: ['coding-agent-loop', 'project-profile-catalog'],
    boundary: 'Profiles · Review · Remediation',
  },
  {
    id: 'coding-langgraph',
    eyebrow: 'Development system · LangGraph',
    name: 'Coding / LangGraph',
    description: 'Checkpointed LangGraph orchestration using the same Prompt, profiles, Bundle and Codex write gate.',
    studioUrl: 'http://localhost:4130/docs',
    apiUrl: 'http://localhost:4130/healthz',
    port: ':4130',
    accent: '#62dfff',
    workflows: ['langgraph-coding-agent-loop', 'SQLite checkpoints'],
    boundary: 'Parallel engine · Shared runtime',
  },
  {
    id: 'theme',
    eyebrow: 'Research runtime',
    name: 'Theme Research',
    description: 'Canonical theme chokepoint workflow with stage projection, product confirmation, and Python continuation.',
    studioUrl: 'http://localhost:3001/workflows',
    apiUrl: 'http://localhost:4112/api/workflows',
    port: ':4112',
    accent: '#a99cff',
    workflows: ['theme-chokepoint-m0', 'theme-chokepoint-historical-projection'],
    boundary: 'Projection · Confirmation · Research',
  },
];

export default function Home() {
  const [states, setStates] = useState<Record<string, ServiceState>>({});
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const results = await Promise.all(
      services.map(async (service) => {
        try {
          const response = await fetch(service.apiUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error('offline');
          const payload = (await response.json()) as Record<string, unknown>;
          const workflowCount = service.id === 'coding-langgraph' ? 1 : Object.keys(payload).length;
          return [service.id, { online: true, workflowCount, checkedAt: new Date() }] as const;
        } catch {
          return [service.id, { online: false, workflowCount: 0, checkedAt: new Date() }] as const;
        }
      }),
    );
    setStates(Object.fromEntries(results));
    setRefreshing(false);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <main className="hub-shell">
      <div className="noise" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>LOCAL AGENT PLATFORM</span>
        </div>
        <button className="refresh-button" onClick={refresh} disabled={refreshing}>
          <span className={refreshing ? 'spin' : ''}>↻</span>
          {refreshing ? 'Checking' : 'Refresh status'}
        </button>
      </header>

      <section className="hero">
        <p className="kicker">Independent runtimes · one control surface</p>
        <h1>Choose where<br />you want to work.</h1>
        <p className="hero-copy">
          One local doorway for your agent systems. Each service keeps its own permissions,
          database, runtime, and failure boundary.
        </p>
      </section>

      <section className="service-grid" aria-label="Agent services">
        {services.map((service, index) => {
          const state = states[service.id];
          const online = state?.online;
          return (
            <article className="service-card" key={service.id} style={{ '--accent': service.accent } as React.CSSProperties}>
              <div className="card-index">0{index + 1}</div>
              <div className="card-head">
                <div>
                  <p className="eyebrow">{service.eyebrow}</p>
                  <h2>{service.name}</h2>
                </div>
                <div className={`status-pill ${state ? (online ? 'online' : 'offline') : 'checking'}`}>
                  <span />
                  {state ? (online ? 'Online' : 'Offline') : 'Checking'}
                </div>
              </div>

              <p className="service-description">{service.description}</p>

              <div className="signal-row">
                <div>
                  <span className="signal-label">API</span>
                  <strong>{service.port}</strong>
                </div>
                <div>
                  <span className="signal-label">Workflows</span>
                  <strong>{state?.online ? state.workflowCount : '—'}</strong>
                </div>
                <div>
                  <span className="signal-label">Boundary</span>
                  <strong className="boundary-copy">Isolated</strong>
                </div>
              </div>

              <div className="workflow-list">
                {service.workflows.map((workflow) => <span key={workflow}>{workflow}</span>)}
              </div>

              <div className="card-footer">
                <p>{service.boundary}</p>
                <a href={service.studioUrl} target="_blank" rel="noreferrer" className="open-button">
                  {service.id === 'coding-langgraph' ? 'Open API' : 'Open Studio'} <span aria-hidden="true">↗</span>
                </a>
              </div>
            </article>
          );
        })}
      </section>

      <footer className="footer-line">
        <span>Hub <b>→</b> independent orchestration engines</span>
        <span className="footer-status"><i /> Auto-check every 15s</span>
      </footer>
    </main>
  );
}
