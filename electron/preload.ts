import { ipcRenderer, contextBridge } from 'electron'
import type { WorkbenchIpc } from '../src/shared/ipc'

const api: WorkbenchIpc = {
  pickNewProjectPath() {
    return ipcRenderer.invoke('workbench:pickNewProjectPath')
  },
  pickProjectFolder() {
    return ipcRenderer.invoke('workbench:pickProjectFolder')
  },
  createProject(input) {
    return ipcRenderer.invoke('workbench:createProject', input)
  },
  openProject(input) {
    return ipcRenderer.invoke('workbench:openProject', input)
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
}

contextBridge.exposeInMainWorld('workbench', api)
