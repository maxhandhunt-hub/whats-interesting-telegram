"""Windows desktop control. Credentials never cross the GUI/network bridge."""
import json
import os
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path
from PySide6.QtCore import QObject,Signal,QTimer,QLockFile
from PySide6.QtGui import QAction
from PySide6.QtWidgets import QApplication,QMainWindow,QWidget,QVBoxLayout,QHBoxLayout,QGridLayout,QLabel,QPushButton,QPlainTextEdit,QDialog,QFormLayout,QComboBox,QSpinBox,QCheckBox,QDialogButtonBox,QMessageBox,QSystemTrayIcon,QMenu,QStyle
from . import secure_store as store,oauth
from .runtime import Worker,QueueClient

class Events(QObject):message=Signal(str,str)

class Window(QMainWindow):
    def __init__(self):
        super().__init__();self.setWindowTitle('Что интересного? — локальный обработчик');self.resize(800,750)
        self.cfg=store.settings();self.worker=None;self.busy=False;self.closing=False
        self.events=Events();self.events.message.connect(self.message)
        self.catalog=[]
        root=QWidget();self.setCentralWidget(root);layout=QVBoxLayout(root);layout.setContentsMargins(28,24,28,24);layout.setSpacing(12)
        title=QLabel('Что интересного?');title.setStyleSheet('font-size:28px;font-weight:650');layout.addWidget(title)
        description=QLabel('Локальный обработчик Mini App • используется подписка ChatGPT');description.setWordWrap(True);layout.addWidget(description)
        self.states={}
        for key,value in [('supabase','Supabase: не проверен'),('chatgpt','ChatGPT: вход сохранён' if oauth.read().get('access_token') else 'ChatGPT: требуется вход'),('model','Модель: '+self.cfg['model']),('worker','Обработчик: остановлен'),('stage','Последнее задание: —')]:
            label=QLabel(value);label.setWordWrap(True);self.states[key]=label;layout.addWidget(label)
        grid=QGridLayout();layout.addLayout(grid);self.buttons={}
        commands=[('Запустить',self.start),('Остановить',self.stop),('Войти через ChatGPT',self.login),('Отключить ChatGPT',self.disconnect),('Проверить подключение',self.check),('Настройки',self.settings),('Открыть настройки использования ChatGPT',lambda:webbrowser.open('https://chatgpt.com/settings/usage')),('Открыть Mini App',lambda:webbrowser.open('https://maxhandhunt-hub.github.io/whats-interesting-telegram/'))]
        for i,(text,fn) in enumerate(commands):
            b=QPushButton(text);b.clicked.connect(fn);grid.addWidget(b,i//2,i%2);self.buttons[text]=b
        self.error=QLabel('');self.error.setWordWrap(True);self.error.setStyleSheet('color:#bd3535');layout.addWidget(self.error)
        layout.addWidget(QLabel('История заданий и состояние'))
        self.history=QPlainTextEdit();self.history.setReadOnly(True);self.history.setMaximumBlockCount(200);layout.addWidget(self.history,1)
        p=store.DATA/'worker.log'
        if p.exists():self.history.setPlainText(p.read_text('utf-8')[-18000:])
        note=QLabel('Один запрос GPT за раз. Кэш обзоров — 15 минут. Погода работает в Supabase.\nЕсли ноутбук выключен, Mini App сообщит о недоступности новостного обработчика.\nПлатные API и автоматическое пополнение не используются.');note.setWordWrap(True);layout.addWidget(note)
        self.tray=QSystemTrayIcon(self.style().standardIcon(QStyle.SP_ComputerIcon),self)
        menu=QMenu();menu.addAction('Открыть',self.showNormal);menu.addAction('Запустить',self.start);menu.addAction('Остановить',self.stop);menu.addAction('Выход',self.quit)
        self.tray.setContextMenu(menu);self.tray.activated.connect(lambda reason:self.showNormal() if reason==QSystemTrayIcon.DoubleClick else None);self.tray.show()
    def background(self,fn,success):
        def run():
            try:value=fn();self.events.message.emit(success,json.dumps(value,ensure_ascii=False) if not isinstance(value,str) else value)
            except Exception as error:self.events.message.emit('error',str(error) if isinstance(error,RuntimeError) else 'Операция не выполнена. Проверьте соединение и настройки.')
        threading.Thread(target=run,daemon=True).start()
    def message(self,kind,value):
        if kind in self.states:self.states[kind].setText(value if kind in ('supabase','chatgpt') else 'Состояние: '+value)
        elif kind=='error':self.error.setText(value);self.history.appendPlainText(datetime.now().strftime('%H:%M:%S')+' Ошибка: '+value);self.busy=False
        elif kind=='catalog':
            self.catalog=json.loads(value);self.states['chatgpt'].setText('ChatGPT: разрешено использование подписки');self.error.clear();self.busy=False
            if self.cfg['model'] not in [x[0] for x in self.catalog] and self.catalog:
                self.cfg['model']=next((x[0] for x in self.catalog if 'luna' in x[0]),self.catalog[0][0]);store.save('worker-settings.bin',self.cfg);self.states['model'].setText('Модель: '+self.cfg['model'])
        elif kind=='started':self.states['worker'].setText('Обработчик: запущен');self.error.clear();self.busy=False
        elif kind=='job':self.history.appendPlainText(datetime.now().strftime('%H:%M:%S')+' Получено задание: '+value)
        elif kind=='done':self.error.clear();self.history.appendPlainText(datetime.now().strftime('%H:%M:%S')+' Выполнено: '+value)
    def start(self):
        if self.worker or self.busy:return
        self.busy=True
        def run():
            catalog=oauth.models()
            if self.cfg['model'] not in [x[0] for x in catalog]:raise RuntimeError('Модель недоступна. Нажмите «Проверить подключение», затем выберите модель.')
            worker=Worker(self.cfg,self.events.message.emit)
            worker.start();self.worker=worker
            return ''
        self.background(run,'started')
    def stop(self):
        if not self.worker:return
        worker=self.worker;self.states['worker'].setText('Обработчик: останавливается…');self.busy=True
        threading.Thread(target=worker.stop,daemon=True).start()
        def poll():
            if any(t.is_alive() for t in worker.threads):QTimer.singleShot(250,poll);return
            self.worker=None;self.busy=False;self.states['worker'].setText('Обработчик: остановлен')
            if self.closing:QApplication.quit()
        QTimer.singleShot(250,poll)
    def check(self):
        if self.busy:return
        self.busy=True
        def run():
            catalog=oauth.models()
            QueueClient(self.cfg).call('ping',ready=bool(self.worker and not self.worker.paused),model=self.cfg['model'])
            self.events.message.emit('supabase','Supabase: соединение проверено')
            return catalog
        self.background(run,'catalog')
    def login(self):
        if self.worker or self.busy:QMessageBox.information(self,'Вход','Сначала остановите обработчик.');return
        self.busy=True;self.states['chatgpt'].setText('ChatGPT: завершите вход и разрешение использования подписки в браузере…')
        def run():oauth.sign_in();return oauth.models()
        self.background(run,'catalog')
    def disconnect(self):
        if self.worker or self.busy:QMessageBox.information(self,'Отключение','Сначала остановите обработчик.');return
        oauth.disconnect();self.states['chatgpt'].setText('ChatGPT: отключён локально');self.error.clear()
    def settings(self):
        if self.worker or self.busy:QMessageBox.information(self,'Настройки','Сначала остановите обработчик.');return
        dlg=QDialog(self);dlg.setWindowTitle('Настройки локального обработчика');dlg.setMinimumWidth(540);form=QFormLayout(dlg)
        model=QComboBox();models=self.catalog or [(self.cfg['model'],self.cfg['model'])]
        for slug,name in models:model.addItem(name,slug)
        model.setCurrentIndex(max(0,model.findData(self.cfg['model'])));form.addRow('Модель из каталога аккаунта',model)
        timeout=QSpinBox();timeout.setRange(60,600);timeout.setValue(self.cfg['timeout']);form.addRow('Тайм-аут GPT, секунд',timeout)
        daily=QSpinBox();daily.setRange(1,100);daily.setValue(self.cfg['daily_limit']);form.addRow('Максимум запросов GPT в день',daily)
        web=QCheckBox('Использовать проверенный web_search');web.setChecked(self.cfg['web_search']);form.addRow(web)
        auto=QCheckBox('Автозапуск при входе в Windows');auto.setChecked(self.cfg['autostart']);form.addRow(auto)
        minimized=QCheckBox('Запускать в системном трее');minimized.setChecked(self.cfg['minimized']);form.addRow(minimized)
        form.addRow(QLabel('Кэш — 15 минут. Лимиты подписки дополнительно применяет OpenAI.'))
        buttons=QDialogButtonBox(QDialogButtonBox.Save|QDialogButtonBox.Cancel);buttons.button(QDialogButtonBox.Save).setText('Сохранить');buttons.button(QDialogButtonBox.Cancel).setText('Отмена');buttons.accepted.connect(dlg.accept);buttons.rejected.connect(dlg.reject);form.addRow(buttons)
        if dlg.exec()!=QDialog.Accepted:return
        cfg={**self.cfg,'model':model.currentData(),'timeout':timeout.value(),'daily_limit':daily.value(),'web_search':web.isChecked(),'autostart':auto.isChecked(),'minimized':minimized.isChecked()}
        self.autostart(cfg['autostart']);self.cfg=cfg;store.save('worker-settings.bin',cfg);self.states['model'].setText('Модель: '+cfg['model'])
    def autostart(self,enabled):
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            if enabled:
                command=f'"{sys.executable}" --start' if getattr(sys,'frozen',False) else f'"{Path(sys.executable).with_name("pythonw.exe")}" "{Path(__file__).resolve().parents[1]/"run_worker.py"}" --start'
                winreg.SetValueEx(key,'WhatsInterestingMiniAppWorker',0,winreg.REG_SZ,command)
            else:
                try:winreg.DeleteValue(key,'WhatsInterestingMiniAppWorker')
                except FileNotFoundError:pass
    def closeEvent(self,event):event.ignore();self.hide()
    def quit(self):
        self.closing=True
        if self.worker:self.stop()
        elif self.busy:QTimer.singleShot(500,self.quit)
        else:QApplication.quit()

def main():
    app=QApplication(sys.argv);app.setQuitOnLastWindowClosed(False)
    lock=QLockFile(str(store.DATA/'worker-app.lock'));lock.setStaleLockTime(0)
    if not lock.tryLock(100):QMessageBox.information(None,'Что интересного?','Обработчик уже запущен. Откройте его из системного трея.');return
    app.setStyle('Fusion');app.setStyleSheet('QWidget{font-family:Segoe UI;font-size:13px}QMainWindow{background:#f3f5fa}QPushButton{padding:10px 14px}QPlainTextEdit{background:white;border:1px solid #d4dce8;border-radius:8px;padding:8px}')
    window=Window()
    if not window.cfg['minimized']:window.show()
    if '--smoke-test' in sys.argv:QTimer.singleShot(1200,app.quit)
    elif '--self-test' in sys.argv:
        def test():
            window.start()
            def stop_test():
                if window.busy:QTimer.singleShot(300,stop_test);return
                window.quit()
            QTimer.singleShot(1500,stop_test)
        QTimer.singleShot(0,test)
    elif '--start' in sys.argv:QTimer.singleShot(0,window.start)
    sys.exit(app.exec())
