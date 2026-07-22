import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { UploadPanel } from './UploadPanel.js';
import { ImportPanel } from './ImportPanel.js';
import { ThemeToggle } from './ThemeToggle.js';
import { useTheme } from '../hooks/useTheme.js';
import { VaultPage } from '../views/VaultPage.js';
import { BrowsePage } from '../views/BrowsePage.js';
import { ModelPage } from '../views/ModelPage.js';
import { ImportWizardPage } from '../views/ImportWizardPage.js';

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

// Persistent shell around the routed views. Three things live here
// specifically because they must survive navigating between routes:
//
// 1. UploadPanel / ImportPanel — mounted above the <Routes> switch so an
//    in-flight upload or folder-import doesn't disappear (and, worse,
//    silently keep running with no visible progress) if the user
//    navigates away from Vault mid-transfer. This is the same reasoning
//    as the pre-router root-mount comments they moved from (former
//    App.tsx:646-651) — routes are just a new way to "change views", and
//    that reasoning applies equally to route changes.
// 2. The top-level Browse/Vault/Projects nav switch, so there's a
//    consistent way to move between sections regardless of which one is
//    currently active.
// 3. Theme toggle + logout (#2168, moved out of VaultPage's header): both
//    are app-wide, not Vault-specific, so every route should have them
//    without navigating back to Vault first. useTheme() is safe to call
//    from exactly one place -- moving it here (instead of also leaving a
//    second instance in VaultPage) means there's one source of truth for
//    theme state, same as before the move. The Settings (admin) button
//    stays in VaultPage's header -- it opens VaultPage's own AdminSettings
//    modal instance, which isn't hoisted here.
//
// GlobalDropZone deliberately did NOT move here — see VaultPage.tsx for
// why (its drop targets depend on Vault's folder/project selection state,
// which isn't lifted above the route switch in this ticket).
//
// "Projects" doesn't have its own route yet (per the #2153 plan, Projects
// stays inside Vault's sidebar as the "what am I building" layer for now),
// so it points at /vault same as the Vault link — not a placeholder route,
// just the existing destination for that functionality today.
//
// Landing flip (#2168): / is now Browse (search-first discovery, see
// BrowsePage.tsx), and Vault moved to /vault only -- the old / alias from
// #2156/A3 is gone. /library redirects to / rather than staying a second
// near-duplicate list page: Browse absorbed everything LibraryPage did
// (search, sort, grid, New Model) plus category chips and deep-linkable
// state, so keeping both would just be two ways to reach the same
// underlying view. Old bookmarks/links to /library still land somewhere
// correct.
export function AppShell({ logout, authRequired }: Props) {
  const { theme, cycleTheme } = useTheme();

  return (
    <div className="flex flex-col h-screen">
      <nav className="flex items-center gap-1 px-3 py-1.5 bg-surface-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <NavLink to="/" end className={navLinkClass}>Browse</NavLink>
        <NavLink to="/vault" className={navLinkClass}>Vault</NavLink>
        <NavLink to="/vault" className={navLinkClass}>Projects</NavLink>
        <div className="flex-1" />
        <ThemeToggle theme={theme} onCycle={cycleTheme} />
        {authRequired && (
          <button
            onClick={logout}
            title="Sign out"
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <LogOut size={16} />
          </button>
        )}
      </nav>

      <div className="flex-1 min-h-0">
        <Routes>
          <Route path="/" element={<BrowsePage />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/library" element={<Navigate to="/" replace />} />
          <Route path="/models/:id" element={<ModelPage />} />
          {/* Zip ImportWizard (#2173, Phase C) -- upload a MakerWorld/
              Printables/Thingiverse zip, edit the classified draft plan,
              commit into a real model. Entry point is BrowsePage's
              "Import zip" button. */}
          <Route path="/import" element={<ImportWizardPage />} />
        </Routes>
      </div>

      <UploadPanel />
      <ImportPanel />
    </div>
  );
}
