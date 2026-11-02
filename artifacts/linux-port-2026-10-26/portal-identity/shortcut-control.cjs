const {app,BrowserWindow,globalShortcut}=require('electron');
app.setName('Klippt Shortcut Control');
app.setDesktopName('co.dyberg.klippt.control.desktop');
const log=(event,data={})=>console.log(JSON.stringify({event,time:Date.now(),...data}));
let win;
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:500,height:240,title:'Klippt Shortcut Control'});
 await win.loadURL('data:text/html,<body style="background:cornsilk;font:24px sans-serif">Shortcut control: Ctrl+Shift+O restores this window. Ctrl+Shift+Space logs transport.</body>');
 for(const event of ['focus','blur','show','hide','minimize','restore'])win.on(event,()=>log('window-'+event));
 for(const accelerator of ['CommandOrControl+Shift+O','CommandOrControl+Shift+Space'])log('registered',{accelerator,success:globalShortcut.register(accelerator,()=>{log('callback',{accelerator,minimized:win.isMinimized(),visible:win.isVisible()});if(accelerator.endsWith('+O')){if(win.isMinimized())win.restore();win.show();win.focus();setTimeout(()=>log('after-open',{minimized:win.isMinimized(),visible:win.isVisible(),focused:win.isFocused()}),300);}})});
 log('ready',{electron:process.versions.electron,chrome:process.versions.chrome});
 setTimeout(()=>app.quit(),90000);
});
app.on('will-quit',()=>{globalShortcut.unregisterAll();log('quit');});
