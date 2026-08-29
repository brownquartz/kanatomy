import { useRef, useState, useCallback } from 'react';

const API_URL = process.env.REACT_APP_API_URL ?? 'http://localhost:4000';

export default function HandwritingCanvas({ onRecognize }) {
  const canvasRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  const [currentStroke, setCurrentStroke] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [loading, setLoading] = useState(false);

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const startDrawing = useCallback((e) => {
    e.preventDefault();
    const { x, y } = getPos(e);
    setIsDrawing(true);
    setCurrentStroke({ xArray: [x], yArray: [y] });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, []);

  const draw = useCallback((e) => {
    e.preventDefault();
    if (!isDrawing || !currentStroke) return;
    const { x, y } = getPos(e);

    setCurrentStroke((prev) => ({
      xArray: [...prev.xArray, x],
      yArray: [...prev.yArray, y],
    }));

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineTo(x, y);
    ctx.stroke();
  }, [isDrawing, currentStroke]);

  const endDrawing = useCallback((e) => {
    e.preventDefault();
    if (!isDrawing || !currentStroke) return;
    setIsDrawing(false);
    setStrokes((prev) => [...prev, [currentStroke.xArray, currentStroke.yArray]]);
    setCurrentStroke(null);
  }, [isDrawing, currentStroke]);

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStrokes([]);
    setCurrentStroke(null);
    setIsDrawing(false);
  };

  const handleRecognize = async () => {
    if (strokes.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/handwriting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ink: strokes, width: 280, height: 280 }),
      });
      const data = await res.json();
      onRecognize(data.candidates);
    } catch (err) {
      console.error('Handwriting recognition failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={280}
        height={280}
        style={{
          border: '1px solid #ccc',
          borderRadius: '4px',
          cursor: 'crosshair',
          display: 'block',
          background: '#fff',
          touchAction: 'none',
        }}
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={endDrawing}
        onPointerLeave={endDrawing}
      />
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <button onClick={handleClear}>消去</button>
        <button onClick={handleRecognize} disabled={strokes.length === 0 || loading}>
          {loading ? '認識中…' : '認識'}
        </button>
      </div>
    </div>
  );
}
