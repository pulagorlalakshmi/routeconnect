import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, UserPlus, Phone, Eye, EyeOff, MapPin } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Signup() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!phone.trim()) {
      setError('Please enter your phone number.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await register(name, email, phone, password, confirm);
      navigate('/dashboard');
    } catch (e) {
      setError((e as Error).message || 'Unable to sign up. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#E7F0EC] px-4 py-10 sm:px-6 lg:px-8 flex items-center justify-center">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 lg:flex-row lg:items-center lg:justify-between">
        
        {/* Info pitch section */}
        <section className="space-y-6 text-[#1F2933] lg:max-w-md shrink-0">
          <div className="flex items-center gap-4 border-l-4 border-[#146B5B] bg-white p-6 shadow-sm">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-xl bg-[#146B5B] text-white">
              <MapPin className="h-8 w-8" />
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-tight text-[#1F2933] sm:text-5xl">
                RouteConnect
              </h1>
              <p className="mt-2 text-xs uppercase tracking-wider font-bold text-[#146B5B]">
                Create your RouteConnect account
              </p>
            </div>
          </div>
          <p className="text-[#667085] text-sm font-semibold max-w-sm pl-4 leading-relaxed">
            Save recent searches and keep useful route combinations close at hand.
          </p>
        </section>

        {/* Signup form Card */}
        <section className="mx-auto w-full max-w-md">
          <div className="rounded-xl border border-[#D9DED9] bg-white p-8 shadow-sm sm:p-10">
            <div className="flex items-center gap-3">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#E8F1EE] text-[#146B5B]">
                <UserPlus className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs text-[#146B5B] font-extrabold uppercase tracking-wider">A few details first</p>
                <p className="text-xl font-black text-[#1F2933]">Create account</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              <div className="space-y-1">
                <label className="block text-sm font-bold text-blue-950">Full Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  type="text"
                  placeholder="Jane Doe"
                  className="w-full rounded-xl border border-[#D9DED9] bg-white px-4 py-2.5 text-sm text-[#1F2933] outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-bold text-[#1F2933]">Email Address</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-400" />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-blue-200 bg-blue-50/20 px-12 py-2.5 text-sm text-blue-900 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-bold text-[#1F2933]">Phone Number</label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-400" />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    type="tel"
                    placeholder="Enter phone number..."
                    className="w-full rounded-xl border border-blue-200 bg-blue-50/20 px-12 py-2.5 text-sm text-blue-900 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-bold text-[#1F2933]">Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-400" />
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Create secure password..."
                    className="w-full rounded-xl border border-blue-200 bg-blue-50/20 px-12 py-2.5 text-sm text-blue-900 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-400 hover:text-blue-600 transition"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-bold text-[#1F2933]">Confirm Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-400" />
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="Confirm password..."
                    className="w-full rounded-xl border border-blue-200 bg-blue-50/20 px-12 py-2.5 text-sm text-blue-900 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-400 hover:text-blue-600 transition"
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-2.5">
                  <p className="text-xs text-red-700 font-extrabold">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 py-3 text-sm font-bold text-white shadow-lg transition hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Registering account...' : 'Create Account'}
              </button>

              <div className="text-center text-sm">
                <p className="text-blue-800">
                  Already have an account?{' '}
                  <Link
                    to="/login"
                    className="font-extrabold text-blue-600 hover:text-blue-800 transition"
                  >
                    Sign In
                  </Link>
                </p>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
