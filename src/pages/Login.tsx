import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, MapPin, Eye, EyeOff, User, Phone, ChevronLeft, Bookmark } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const reason = searchParams.get('reason');
  const routeFrom = searchParams.get('from');
  const routeTo = searchParams.get('to');
  const returnUrl = searchParams.get('returnUrl');

  const [tab, setTab] = useState<'signin' | 'signup'>(
    searchParams.get('tab') === 'signup' ? 'signup' : 'signin'
  );

  // Sign In fields
  const [emailOrPhone, setEmailOrPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Sign Up fields
  const [name, setName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showSignupPassword, setShowSignupPassword] = useState(false);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignInSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!emailOrPhone.trim()) {
      setError('Please enter your email address or phone number.');
      return;
    }
    if (password.length < 6) {
      setError('Password should be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      await login(emailOrPhone, password, returnUrl ? decodeURIComponent(returnUrl) : undefined);
    } catch (e) {
      setError((e as Error).message || 'Unable to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!signupEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!phone.trim()) {
      setError('Please enter your phone number.');
      return;
    }
    if (signupPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (signupPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await register(name, signupEmail, phone, signupPassword, confirmPassword, returnUrl ? decodeURIComponent(returnUrl) : undefined);
    } catch (e) {
      setError((e as Error).message || 'Unable to sign up. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#E7F0EC] px-4 py-10 flex items-center justify-center">
      <div className="w-full max-w-md">
        
        {/* Back navigation */}
        <button
          onClick={() => (returnUrl ? navigate(decodeURIComponent(returnUrl)) : navigate('/dashboard'))}
          className="inline-flex items-center gap-1.5 text-xs font-black uppercase text-[#146B5B] hover:text-[#0f5447] transition mb-4 cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" /> Back to Planner
        </button>

        {/* Brand header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#146B5B] text-white shadow-sm mb-2.5">
            <MapPin className="h-6 w-6" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-[#1F2933]">
            RouteConnect
          </h1>
          <p className="text-xs font-semibold text-[#667085] mt-0.5">
            Practical Route Combinations
          </p>
        </div>

        {/* Main Card */}
        <div className="rounded-2xl border border-[#D9DED9] bg-white p-7 shadow-sm sm:p-9">
          
          {/* Reason Banner: Save Route */}
          {reason === 'save_route' && (
            <div className="mb-6 rounded-xl bg-emerald-50 border border-emerald-300 p-4 shadow-2xs">
              <div className="flex items-start gap-3">
                <Bookmark className="h-5 w-5 text-[#146B5B] shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-black text-emerald-950 uppercase tracking-wider">
                    Save Route Itinerary
                  </p>
                  <p className="text-xs text-emerald-900 mt-1 font-semibold leading-relaxed">
                    {routeFrom && routeTo
                      ? `Please sign in or sign up to save your route (${routeFrom} ➔ ${routeTo}) to your account.`
                      : 'Please sign in or sign up to save this route to your journeys.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Tab Switcher: Sign In & Sign Up */}
          <div className="flex border-b border-[#D9DED9] mb-6">
            <button
              type="button"
              onClick={() => {
                setTab('signin');
                setError('');
              }}
              className={`flex-1 pb-3 text-sm font-extrabold border-b-2 transition cursor-pointer text-center ${
                tab === 'signin'
                  ? 'border-[#146B5B] text-[#146B5B]'
                  : 'border-transparent text-[#667085] hover:text-[#1F2933]'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('signup');
                setError('');
              }}
              className={`flex-1 pb-3 text-sm font-extrabold border-b-2 transition cursor-pointer text-center ${
                tab === 'signup'
                  ? 'border-[#146B5B] text-[#146B5B]'
                  : 'border-transparent text-[#667085] hover:text-[#1F2933]'
              }`}
            >
              Sign Up
            </button>
          </div>

          {/* SIGN IN FORM */}
          {tab === 'signin' ? (
            <form onSubmit={handleSignInSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Email / Mobile Number
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={emailOrPhone}
                    onChange={(e) => setEmailOrPhone(e.target.value)}
                    type="text"
                    placeholder="Enter email or mobile..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-4 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter password..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-10 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#667085] hover:text-[#1F2933] transition cursor-pointer"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-3.5 space-y-2.5" role="alert">
                  <p className="text-xs text-red-700 font-extrabold">{error}</p>
                  {/no account|sign up first/i.test(error) && (
                    <div className="pt-2 border-t border-red-200/80 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-red-900">Don't have an account yet?</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTab('signup');
                          if (emailOrPhone.includes('@')) {
                            setSignupEmail(emailOrPhone.trim());
                          } else {
                            setPhone(emailOrPhone.trim());
                          }
                          setError('');
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#146B5B] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#0f5447] transition cursor-pointer shadow-xs"
                      >
                        Sign Up First →
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[#146B5B] hover:bg-[#0E4E42] py-3 text-sm font-bold text-white shadow-sm transition hover:shadow disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>

              <div className="text-center text-xs pt-2">
                <p className="text-[#667085]">
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setTab('signup');
                      setError('');
                    }}
                    className="font-black text-[#146B5B] hover:underline transition cursor-pointer"
                  >
                    Sign Up here
                  </button>
                </p>
              </div>
            </form>
          ) : (
            /* SIGN UP FORM */
            <form onSubmit={handleSignUpSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Full Name
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    type="text"
                    placeholder="Enter full name..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-4 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    type="email"
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-4 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    type="tel"
                    placeholder="Enter phone number..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-4 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    type={showSignupPassword ? 'text' : 'password'}
                    placeholder="Create secure password..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-10 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSignupPassword(!showSignupPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#667085] hover:text-[#1F2933] transition cursor-pointer"
                    aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                  >
                    {showSignupPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[#1F2933] uppercase tracking-wider">
                  Confirm Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
                  <input
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    type="password"
                    placeholder="Re-enter password..."
                    className="w-full rounded-xl border border-[#D9DED9] bg-white pl-10 pr-4 py-2.5 text-sm text-[#1F2933] placeholder-[#667085]/60 outline-none transition focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
                    required
                    minLength={6}
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-3" role="alert">
                  <p className="text-xs text-red-700 font-extrabold">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[#146B5B] hover:bg-[#0E4E42] py-3 text-sm font-bold text-white shadow-sm transition hover:shadow disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {loading ? 'Creating account...' : 'Sign Up'}
              </button>

              <div className="text-center text-xs pt-2">
                <p className="text-[#667085]">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setTab('signin');
                      setError('');
                    }}
                    className="font-black text-[#146B5B] hover:underline transition cursor-pointer"
                  >
                    Sign In here
                  </button>
                </p>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
