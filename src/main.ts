import { CASE_01 } from './cases/case01';
import { Game } from './game';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

new Game(root, CASE_01);
