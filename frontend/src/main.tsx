import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './styles.css';
import { BrowserRouter } from 'react-router';
import { BoardRouter } from './BoardRouter';
import { ErrorBoundary } from './ErrorBoundary';

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary label="app"><BrowserRouter><BoardRouter /></BrowserRouter></ErrorBoundary></StrictMode>);
