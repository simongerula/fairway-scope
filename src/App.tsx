import { useCallback, useEffect, useState } from 'react';
import Practice from './components/Practice';
import History from './components/History';
import SetupWizard from './components/SetupWizard';
import { loadSettings, saveSettings, type Settings } from './lib/settings';

type Tab = 'practice' | 'history' | 'setup';

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>(() =>
    loadSettings().calibrated ? 'practice' : 'setup'
  );

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const patch = useCallback((partial: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...partial }));
  }, []);

  return (
    <div className="app">
      <div className="screen-wrap">
        {tab === 'setup' && (
          <SetupWizard
            settings={settings}
            patch={patch}
            onDone={() => setTab('practice')}
          />
        )}
        {tab === 'practice' && (
          <Practice settings={settings} patch={patch} onOpenSetup={() => setTab('setup')} />
        )}
        {tab === 'history' && <History />}
      </div>

      <nav className="tabbar">
        <button
          className={tab === 'practice' ? 'tab active' : 'tab'}
          onClick={() => setTab('practice')}
        >
          <span className="tab-ico">⛳</span>
          <span className="tab-label">Practice</span>
        </button>
        <button
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          <span className="tab-ico">📊</span>
          <span className="tab-label">Shots</span>
        </button>
        <button
          className={tab === 'setup' ? 'tab active' : 'tab'}
          onClick={() => setTab('setup')}
        >
          <span className="tab-ico">⚙️</span>
          <span className="tab-label">Setup</span>
        </button>
      </nav>
    </div>
  );
}
