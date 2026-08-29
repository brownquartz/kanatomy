// src/index.js
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Create React 18 root
const container = document.getElementById('root');
const root = createRoot(container);

// Render your App
root.render(
  // <React.StrictMode>
    <App />
  // </React.StrictMode>
);
