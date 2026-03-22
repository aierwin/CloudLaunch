const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Shell
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openInApp: (config) => ipcRenderer.invoke('open-in-app', config),

  // Credentials
  loadCredentials: () => ipcRenderer.invoke('load-credentials'),
  saveCredentials: (creds) => ipcRenderer.invoke('save-credentials', creds),
  clearCredentials: () => ipcRenderer.invoke('clear-credentials'),

  // Deployments
  getDeployments: () => ipcRenderer.invoke('get-deployments'),
  saveDeployment: (deployment) => ipcRenderer.invoke('save-deployment', deployment),
  removeDeploymentRecord: (id) => ipcRenderer.invoke('remove-deployment-record', id),

  // CloudFront status
  getDistributionStatus: (config) => ipcRenderer.invoke('get-distribution-status', config),
  disableDistribution: (config) => ipcRenderer.invoke('disable-distribution', config),

  // Directory selection
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // Deploy (new)
  deploy: (config) => ipcRenderer.invoke('deploy', config),
  onDeployProgress: (callback) => {
    ipcRenderer.removeAllListeners('deploy-progress');
    ipcRenderer.on('deploy-progress', (_event, progress) => callback(progress));
  },

  // Update deployment
  updateDeployment: (config) => ipcRenderer.invoke('update-deployment', config),

  // Delete deployment
  deleteDeployment: (config) => ipcRenderer.invoke('delete-deployment', config),

  // Operation progress (update/delete)
  onOperationProgress: (callback) => {
    ipcRenderer.removeAllListeners('operation-progress');
    ipcRenderer.on('operation-progress', (_event, progress) => callback(progress));
  }
});
