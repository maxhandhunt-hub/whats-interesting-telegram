interface TelegramApp {initData:string;colorScheme:'light'|'dark';themeParams:Record<string,string>;ready():void;expand():void;onEvent(name:string,fn:()=>void):void;offEvent(name:string,fn:()=>void):void;BackButton?:{show():void;hide():void;onClick(fn:()=>void):void;offClick(fn:()=>void):void};}
declare global {interface Window{Telegram?:{WebApp:TelegramApp}}}
export const telegram=window.Telegram?.WebApp;
export function applyTheme(){
 document.documentElement.dataset.theme=telegram?.colorScheme||'';
 const p=telegram?.themeParams;
 for(const [key,value] of Object.entries(p||{}))if(/^#[0-9a-f]{6}$/i.test(value))document.documentElement.style.setProperty(`--tg-${key.replaceAll('_','-')}`,value);
}
telegram?.ready();telegram?.expand();applyTheme();telegram?.onEvent('themeChanged',applyTheme);
