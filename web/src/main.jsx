import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { skinEngine } from './skin/skinEngine.js';

// 初始化皮肤引擎：恢复已保存的主题 / 壁纸 / 强调色
skinEngine.init();
const savedAccent = localStorage.getItem('dsw-dream-skin:accent');
if (savedAccent) skinEngine.accent.apply(savedAccent);

createRoot(document.getElementById('root')).render(<App />);
