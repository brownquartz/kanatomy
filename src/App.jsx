// src/App.js
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MainApp from './MainApp';
import KanjiPage from './KanjiPage';
import { LanguageProvider } from './LanguageContext';
import LanguageSettings from './LanguageSettings';
import Footer from './Footer';

export default function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <LanguageSettings />
        <Routes>
          <Route path="/" element={<MainApp />} />
          <Route path="/kanji/:char" element={<KanjiPage />} />
        </Routes>
        <Footer />
      </BrowserRouter>
    </LanguageProvider>
  );
}
