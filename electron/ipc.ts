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

  ipcMain.handle('workbench:pickPointCloudImport', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select point cloud source',
      buttonLabel: 'Choose Point Cloud',
      properties: ['openFile'],
      filters: [{ name: 'Point Clouds', extensions: ['las', 'laz'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0] as string;
    const stats = await import('node:fs/promises').then((fs) => fs.stat(filePath));
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: 'Import Policy',
      message: 'Choose how to register this point cloud source.',
      detail:
        stats.size >= 1024 * 1024 * 1024
          ? 'This file is large. Reference is recommended to avoid copying multi-GB source data into the project.'
          : 'Reference keeps the file in place. Copy duplicates it into the project sources folder.',
      buttons: ['Reference', 'Copy', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response.response === 2) {
      return null;
    }
    return {
      filePath,
      importPolicy: response.response === 1 ? 'copy' : 'reference',
    } as const;
  });

  ipcMain.handle('workbench:createProject', (_event, input: Parameters<WorkbenchIpc['createProject']>[0]) =>
    service.createProject(input),
  );

  ipcMain.handle('workbench:openProject', (_event, input: Parameters<WorkbenchIpc['openProject']>[0]) =>
    service.openProject(input),
  );

  ipcMain.handle('workbench:importPointCloud', (_event, input: Parameters<WorkbenchIpc['importPointCloud']>[0]) =>
    service.importPointCloud(input),
  );

  ipcMain.handle(
    'workbench:loadPointCloudPreview',
    async (event, input: Parameters<WorkbenchIpc['loadPointCloudPreview']>[0]) =>
      service.loadPointCloudPreview(input, (progress) => {
        event.sender.send('workbench:pointCloudPreviewProgress', progress);
      }),
  );

  ipcMain.handle(
    'workbench:loadPointCloudDensifiedNodes',
    (_event, input: Parameters<WorkbenchIpc['loadPointCloudDensifiedNodes']>[0]) =>
      service.loadPointCloudDensifiedNodes(input),
  );

  ipcMain.handle(
    'workbench:generatePointCloudIndex',
    async (event, input: Parameters<WorkbenchIpc['generatePointCloudIndex']>[0]) =>
      service.generatePointCloudIndex(input, (progress) => {
        event.sender.send('workbench:pointCloudIndexProgress', progress);
      }),
  );

  ipcMain.handle(
    'workbench:cancelPointCloudIndex',
    (_event, input: Parameters<WorkbenchIpc['cancelPointCloudIndex']>[0]) => service.cancelPointCloudIndex(input),
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
