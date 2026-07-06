import { ipcRenderer, contextBridge } from 'electron'
import type { WorkbenchIpc } from '../src/shared/ipc'

const api: WorkbenchIpc = {
  pickNewProjectPath() {
    return ipcRenderer.invoke('workbench:pickNewProjectPath')
  },
  pickProjectFolder() {
    return ipcRenderer.invoke('workbench:pickProjectFolder')
  },
  pickPointCloudImport() {
    return ipcRenderer.invoke('workbench:pickPointCloudImport')
  },
  createProject(input) {
    return ipcRenderer.invoke('workbench:createProject', input)
  },
  openProject(input) {
    return ipcRenderer.invoke('workbench:openProject', input)
  },
  importPointCloud(input) {
    return ipcRenderer.invoke('workbench:importPointCloud', input)
  },
  loadPointCloudPreview(input) {
    return ipcRenderer.invoke('workbench:loadPointCloudPreview', input)
  },
  loadPointCloudDensifiedNodes(input) {
    return ipcRenderer.invoke('workbench:loadPointCloudDensifiedNodes', input)
  },
  generatePointCloudIndex(input) {
    return ipcRenderer.invoke('workbench:generatePointCloudIndex', input)
  },
  generateAnalyticSurfels(input) {
    return ipcRenderer.invoke('workbench:generateAnalyticSurfels', input)
  },
  cancelPointCloudIndex(input) {
    return ipcRenderer.invoke('workbench:cancelPointCloudIndex', input)
  },
  cancelAnalyticSurfels(input) {
    return ipcRenderer.invoke('workbench:cancelAnalyticSurfels', input)
  },
  loadPointCloudIndexHierarchy(input) {
    return ipcRenderer.invoke('workbench:loadPointCloudIndexHierarchy', input)
  },
  loadPointCloudIndexTiles(input) {
    return ipcRenderer.invoke('workbench:loadPointCloudIndexTiles', input)
  },
  loadAnalyticSurfelHierarchy(input) {
    return ipcRenderer.invoke('workbench:loadAnalyticSurfelHierarchy', input)
  },
  loadAnalyticSurfelTiles(input) {
    return ipcRenderer.invoke('workbench:loadAnalyticSurfelTiles', input)
  },
  readDerivedSurfaceArtifact(managedPath) {
    return ipcRenderer.invoke('workbench:readDerivedSurfaceArtifact', managedPath)
  },
  saveProject(manifest) {
    return ipcRenderer.invoke('workbench:saveProject', manifest)
  },
  closeProject() {
    return ipcRenderer.invoke('workbench:closeProject')
  },
  addUnitMismatchWarning(input) {
    return ipcRenderer.invoke('workbench:addUnitMismatchWarning', input)
  },
  generatePlaceholderDerivedLayer() {
    return ipcRenderer.invoke('workbench:generatePlaceholderDerivedLayer')
  },
  onPointCloudPreviewProgress(listener) {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
    ipcRenderer.on('workbench:pointCloudPreviewProgress', handler)
    return () => ipcRenderer.removeListener('workbench:pointCloudPreviewProgress', handler)
  },
  onPointCloudIndexProgress(listener) {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
    ipcRenderer.on('workbench:pointCloudIndexProgress', handler)
    return () => ipcRenderer.removeListener('workbench:pointCloudIndexProgress', handler)
  },
  onAnalyticSurfelProgress(listener) {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
    ipcRenderer.on('workbench:analyticSurfelProgress', handler)
    return () => ipcRenderer.removeListener('workbench:analyticSurfelProgress', handler)
  },
}

contextBridge.exposeInMainWorld('workbench', api)
