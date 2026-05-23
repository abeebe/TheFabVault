import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { startUploads } from '../lib/uploadStore.js';

interface Props {
  currentFolderId: string | null;
  currentFolderName: string | null;
  currentProjectId: string | null;
  currentProjectName: string | null;
  // The folder associated with the current project, if any. When the user
  // drops into a project view, files go into both the project and this
  // folder so they aren't orphaned at vault root.
  currentProjectFolderId: string | null;
  currentProjectFolderName: string | null;
}

// Full-screen drag-drop overlay rendered at the App root so files can be
// dropped from any view (home, folder, project). Uploads go to:
//   - the current project, if one is selected
//   - otherwise the current folder
//
// Listeners are bound to window because `pointer-events: none` on the hidden
// overlay would otherwise prevent the initial dragenter from registering.
export function GlobalDropZone({
  currentFolderId,
  currentFolderName,
  currentProjectId,
  currentProjectName,
  currentProjectFolderId,
  currentProjectFolderName,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  // When inside a project view, the project's folder (if set) wins over
  // the sidebar's selected folder so the asset lands with the project.
  const effectiveFolderId = currentProjectId ? currentProjectFolderId : currentFolderId;

  // Hold a ref to the latest folder/project so the window listeners (bound
  // once) always see current values.
  const targetRef = useRef({ folderId: effectiveFolderId, projectId: currentProjectId });
  useEffect(() => {
    targetRef.current = { folderId: effectiveFolderId, projectId: currentProjectId };
  }, [effectiveFolderId, currentProjectId]);

  useEffect(() => {
    function isFileDrag(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes('Files');
    }

    function onDragEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter.current++;
      if (dragCounter.current === 1) setDragging(true);
    }
    function onDragOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    }
    function onDragLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      dragCounter.current--;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setDragging(false);
      }
    }
    function onDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      void startUploads(files, {
        folderId: targetRef.current.folderId,
        projectId: targetRef.current.projectId,
      });
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const handleOverlayDrop = useCallback((e: React.DragEvent) => {
    // The window-level `drop` handler does the real work; this is here to
    // make sure the browser doesn't try to navigate to dropped files even
    // if the bubbling path is interrupted.
    e.preventDefault();
  }, []);

  return (
    <div
      className={`fixed inset-0 z-40 transition-opacity duration-150 ${dragging ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleOverlayDrop}
    >
      <div className="absolute inset-0 bg-accent/20 backdrop-blur-sm border-4 border-dashed border-accent rounded-2xl m-4 flex items-center justify-center">
        <div className="text-center">
          <Upload size={48} className="text-accent mx-auto mb-3" />
          <p className="text-xl font-semibold text-accent">Drop files to upload</p>
          {currentProjectId ? (
            <p className="text-sm text-accent/70 mt-1">
              Files will be added to <span className="font-medium">{currentProjectName ?? 'this project'}</span>
              {currentProjectFolderName && (
                <> in folder <span className="font-medium">{currentProjectFolderName}</span></>
              )}
            </p>
          ) : currentFolderId ? (
            <p className="text-sm text-accent/70 mt-1">
              Files will be added to folder <span className="font-medium">{currentFolderName ?? 'this folder'}</span>
            </p>
          ) : (
            <p className="text-sm text-accent/70 mt-1">Files will be added to your vault</p>
          )}
        </div>
      </div>
    </div>
  );
}
