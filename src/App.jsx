// src/App.jsx
import { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="bg-white p-8 rounded-xl shadow-2xl max-w-sm w-full text-center">
        <h1 className="text-3xl font-extrabold text-blue-600 mb-6">
          部署成功測試
        </h1>
        <p className="text-gray-700 mb-4">
          這是一個基本的計數器應用，用於測試部署是否成功。
        </p>
        <button
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-full transition duration-300 transform hover:scale-105"
          onClick={() => setCount((c) => c + 1)}
        >
          計數器: {count}
        </button>
        <p className="mt-6 text-sm text-gray-500">
          編輯 `src/App.jsx` 並保存以重新加載。
        </p>
      </div>
    </div>
  );
}

export default App;