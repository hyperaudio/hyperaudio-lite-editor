const { app, BrowserWindow } = require('electron')

// Create the window, don't rename the function!
function createWindow () {
  // Create the browser window.
  const win = new BrowserWindow({
    // Width and height of the window, feel free
    // to edit it.
    width: 1200,
    height: 1000,
    webPreferences: {
      nodeIntegration: true
    }
  })

  // Load the index.html file of the app (we will create
  // it later)
  win.loadFile('deepgram.html')
}

// Run the app when it's ready
app.whenReady().then(createWindow)