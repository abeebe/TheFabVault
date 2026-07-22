import { Routes, Route, NavLink } from 'react-router-dom';
import { UploadPanel } from './UploadPanel.js';
import { ImportPanel } from './ImportPanel.js';
import { VaultPage } from '../views/VaultPage.js';
import { LibraryPage } from '../views/LibraryPage.js';
import { ModelPage } from '../views/ModelPage.js';

interface Props {
  logout: () => void;
  authRequired: boolean;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
    isActive
      ? 'bg-accent text-white'
      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
  }`;

// Persistent shell around the routed views. Two things live here
// specifically because they must survive navigating between routes:
//
// 1. UploadPanel / ImportPanel — mounted above the <Routes> switch so an
//    in-flight upload or folder-import doesn't disappear (and, worse,
//    silently keep running with no visible progress) if the user
//    navigates away from Vault mid-transfer. This is the same reasoning
//    as the pre-router root-mount comments they moved from (former
//    App.tsx:646-651) — routes are just a new way to "change views", and
//    that reasoning applies equally to route changes.
// 2. The top-level Library/Vault/Projects nav switch, so there's a
//    consistent way to move between sections regardless of which one is
//    currently active.
//
// GlobalDropZone deliberately did NOT move here — see VaultPage.tsx for
// why (its drop targets depend on Vault's folder/project selection state,
// which isn't lifted above the route switch in this ticket).
//
// "Projects" doesn't have its own route yet (per the #2153 plan, Projects
// stays inside Vault's sidebar as the "what am I building" layer for now),
// so it points at /vault same as the Vault link — not a placeholder route,
// just the existing destination for that functionality today.
export function AppShell({ logout, authRequired }: Props) {
  return (
    <div className="flex flex-col h-screen">
      <nav className="flex items-center gap-1 px-3 py-1.5 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <NavLink to="/library" className={navLinkClass}>Library</NavLink>
        <NavLink to="/vault" className={navLinkClass}>Vault</NavLink>
        <NavLink to="/vault" className={navLinkClass}>Projects</NavLink>
      </nav>

      <div className="flex-1 min-h-0">
        <Routes>
          <Route path="/" element={<VaultPage logout={logout} authRequired={authRequired} />} />
          <Route path="/vault" element={<VaultPage logout={logout} authRequired={authRequired} />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/models/:id" element={<ModelPage />} />
        </Routes>
      </div>

      <UploadPanel />
      <ImportPanel />
    </div>
  );
}
