import { ipcMain, dialog } from 'electron';
import path from 'node:path';
import type { WorkbenchIpc } from '../src/shared/ipc';
import { ProjectService } from './project-service';

const service = new ProjectService();

export function registerWorkbenchIpc(): void {
  ipcMain.handle('workbench:pickNewProjectPath', async () => {
    const result = await dialog.showSaveDialog({
      title: 'New Project — choose location and folder name',
      buttonLabel: 'Create Project',
      defaultPath: 'WB_Project_001',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    return {
      parentDir: path.dirname(result.filePath),
      projectName: path.basename(result.filePath),
    };
  });

  ipcMain.handle('workbench:pickProjectFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Project — select a project folder',
      buttonLabel: 'Open Project',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('workbench:createProject', (_event, input: Parameters<WorkbenchIpc['createProject']>[0]) =>
    service.createProject(input),
  );

  ipcMain.handle('workbench:openProject', (_event, input: Parameters<WorkbenchIpc['openProject']>[0]) =>
    service.openProject(input),
  );

  ipcMain.handle(
    'workbench:readDerivedSurfaceArtifact',
    (_event, managedPath: Parameters<WorkbenchIpc['readDerivedSurfaceArtifact']>[0]) =>
      service.readDerivedSurfaceArtifact(managedPath),
  );

  ipcMain.handle('workbench:saveProject', (_event, manifest: Parameters<WorkbenchIpc['saveProject']>[0]) =>
    service.saveProject(manifest),
  );

  ipcMain.handle('workbench:closeProject', () => service.closeProject());

  ipcMain.handle(
    'workbench:addUnitMismatchWarning',
    (_event, input: Parameters<WorkbenchIpc['addUnitMismatchWarning']>[0]) => service.addUnitMismatchWarning(input),
  );

  ipcMain.handle('workbench:generatePlaceholderDerivedLayer', () => service.generatePlaceholderDerivedLayer());
}
