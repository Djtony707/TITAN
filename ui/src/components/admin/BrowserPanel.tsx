import { useState } from 'react';
import { Globe, Wand2 } from 'lucide-react';
import { solveCaptcha } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

export default function BrowserPanel() {
  const [imageBase64, setImageBase64] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSolve = async () => {
    if (!imageBase64.trim()) return;
    setLoading(true);
    try {
      const data = await solveCaptcha(imageBase64);
      setResult(data.token || data.error || 'No result');
    } catch (e) {
      setResult(String(e));
    }
    setLoading(false);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Browser Tools" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Tools'}, {label:'Browser'}]} />
      <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-4 h-4 text-[#6366f1]" />
          <span className="text-sm font-medium text-[#e4e4e7]">Captcha Solver</span>
        </div>
        <textarea
          value={imageBase64}
          onChange={e => setImageBase64(e.target.value)}
          placeholder="Paste base64 image..."
          className="w-full h-24 p-2 rounded-md bg-[#27272a] border border-[#3f3f46] text-xs text-[#e4e4e7] placeholder-[#52525b] font-mono resize-none"
        />
        <button onClick={handleSolve} disabled={loading} className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1] text-white text-sm font-medium hover:bg-[#4f46e5] disabled:opacity-50">
          <Wand2 className="w-4 h-4" /> {loading ? 'Solving...' : 'Solve Captcha'}
        </button>
        {result && (
          <div className="mt-2 p-2 rounded-md bg-[#27272a] text-xs text-[#e4e4e7] font-mono break-all">{result}</div>
        )}
      </div>
    </div>
  );
}
