import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { MapPin, LogOut, User, Menu, X, Trash2, Bookmark, Briefcase, FileText, ArrowLeft, ExternalLink } from 'lucide-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { getLocalTrips, fetchServerTrips, removeTripFromHistory, saveLocalTrips } from '../utils/tripHistory';
import type { SavedTrip } from '../utils/tripHistory';
import JourneyCard from './JourneyCard';
import RouteCard from './RouteCard';
import { todayLocalIso } from '../utils/dateTime';

interface SavedRoute {
  id: string;
  from: string;
  to: string;
  price?: string | number | null; // null: no fare data exists for timetable-based routes
  duration: number;
  transfers: number;
  modes: string[];
  journey?: any;
  route?: any;
  date?: string;
  searchUrl?: string;
}

export default function Navbar() {
  const { user, sessionId, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  
  // Modals state
  const [showMyTrips, setShowMyTrips] = useState(false);
  const [showSavedRoutes, setShowSavedRoutes] = useState(false);
  const [tripsList, setTripsList] = useState<SavedTrip[]>([]);
  const [routesList, setRoutesList] = useState<SavedRoute[]>([]);
  const [selectedRouteDetail, setSelectedRouteDetail] = useState<SavedRoute | null>(null);
  
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await logout();
    setTripsList([]);
    setShowDropdown(false);
  };

  // Loads parameters dynamically when modal is opened
  const openMyTripsModal = async () => {
    setShowMyTrips(true);
    setShowMobileMenu(false);

    // Immediately load local history for this user
    const local = getLocalTrips(user?.id);
    setTripsList(local);

    // If user is signed in, refresh from server
    if (user && sessionId) {
      const serverTrips = await fetchServerTrips(sessionId);
      if (serverTrips) {
        setTripsList(serverTrips);
        saveLocalTrips(serverTrips, user.id);
      }
    }
  };

  const openSavedRoutesModal = () => {
    const list = JSON.parse(localStorage.getItem('saved_routes') || '[]');
    setRoutesList(list);
    setSelectedRouteDetail(null);
    setShowSavedRoutes(true);
    setShowMobileMenu(false);
  };

  const handleDeleteTrip = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = await removeTripFromHistory(id, user, sessionId);
    setTripsList(updated);
  };

  const handleDeleteRoute = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = routesList.filter(r => r.id !== id);
    localStorage.setItem('saved_routes', JSON.stringify(updated));
    setRoutesList(updated);
    if (selectedRouteDetail?.id === id) {
      setSelectedRouteDetail(null);
    }
  };

  const handleSelectRoute = (route: SavedRoute) => {
    if (route.journey || route.route) {
      setSelectedRouteDetail(route);
    } else {
      setShowSavedRoutes(false);
      const params = new URLSearchParams({
        from: route.from,
        to: route.to,
        date: route.date || todayLocalIso()
      });
      navigate(`/search-results?${params.toString()}`);
    }
  };

  const handleSelectTrip = (trip: SavedTrip) => {
    setShowMyTrips(false);
    const params = new URLSearchParams({
      from: trip.from,
      to: trip.to,
      date: trip.date
    });
    if (trip.time) params.set('time', trip.time);
    navigate(`/search-results?${params.toString()}`);
  };

  const menuItems = [
    { name: 'Home', path: '/dashboard', icon: MapPin },
    { name: 'My Trips', path: '#my-trips', icon: Briefcase, action: openMyTripsModal },
    { name: 'Saved Routes', path: '#saved', icon: Bookmark, action: openSavedRoutesModal },
    { name: 'Data & Policies', path: '/about-data', icon: FileText },
    {
      name: 'Profile',
      path: '/profile',
      icon: User,
      action: !user ? () => setShowDropdown(prev => !prev) : undefined
    },
  ];

  return (
    <nav className="border-b border-[#D9DED9] bg-white shadow-sm sticky top-0 z-50">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo */}
          <Link to="/dashboard" className="flex items-center gap-2 group shrink-0">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#146B5B] text-white">
              <MapPin className="h-4.5 w-4.5" />
            </div>
            <span className="text-lg font-black text-[#1F2933]">RouteConnect</span>
          </Link>

          {/* Desktop Navigation Links */}
          <div className="hidden md:flex items-center gap-6">
            {menuItems.map((item) => {
              const isActive = location.pathname === item.path;
              if (item.action) {
                return (
                  <button
                    key={item.name}
                    onClick={item.action}
                    className="text-xs uppercase tracking-wider font-extrabold text-[#667085] hover:text-[#146B5B] transition cursor-pointer"
                  >
                    {item.name}
                  </button>
                );
              }
              return (
                <Link
                  key={item.name}
                  to={item.path}
                  className={`text-xs uppercase tracking-wider font-extrabold transition ${isActive ? 'text-[#146B5B] border-b-2 border-[#146B5B] pb-1' : 'text-[#667085] hover:text-[#146B5B]'}`}
                >
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* Mobile menu button */}
          <button
            onClick={() => setShowMobileMenu(!showMobileMenu)}
            className="md:hidden text-[#667085] hover:text-[#1F2933] transition"
          >
            {showMobileMenu ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>

          {/* Desktop User / Profile Dropdown */}
          <div className="hidden md:flex items-center shrink-0">
            <div className="relative" ref={dropdownRef}>
              {user ? (
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center gap-2 rounded-full bg-gray-50 px-3.5 py-1.5 text-sm font-semibold text-[#1F2933] border border-[#D9DED9] transition hover:bg-gray-100 cursor-pointer"
                >
                  <div className="flex items-center justify-center h-7 w-7 rounded-full bg-[#146B5B] text-white text-xs font-bold">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <span>{user.name}</span>
                </button>
              ) : (
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-xs font-black text-[#1F2933] border border-[#D9DED9] transition hover:bg-gray-50 hover:border-[#146B5B] shadow-2xs cursor-pointer"
                >
                  <div className="flex items-center justify-center h-6 w-6 rounded-full bg-[#146B5B]/10 text-[#146B5B]">
                    <User className="h-3.5 w-3.5" />
                  </div>
                  <span>Profile</span>
                </button>
              )}

              {showDropdown && (
                user ? (
                  <div className="absolute right-0 mt-2 w-56 rounded-xl bg-white shadow-xl border border-[#D9DED9] z-50 overflow-hidden animate-fadeIn">
                    <div className="px-4 py-3 border-b border-[#D9DED9] bg-gray-50">
                      <p className="text-sm font-bold text-[#1F2933]">{user.name}</p>
                      <p className="text-xs text-[#667085] truncate">{user.email}</p>
                    </div>
                    <div className="py-1">
                      <button
                        onClick={() => {
                          navigate('/profile');
                          setShowDropdown(false);
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-[#1F2933] hover:bg-gray-50 transition cursor-pointer"
                      >
                        <User className="h-4 w-4 text-[#667085]" />
                        User Details
                      </button>
                      <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-red-600 hover:bg-red-50 transition cursor-pointer"
                      >
                        <LogOut className="h-4 w-4" />
                        Logout
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white shadow-xl border border-[#D9DED9] z-50 overflow-hidden animate-fadeIn">
                    <div className="px-4 py-3 bg-gray-50 border-b border-[#D9DED9]">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#146B5B]/10 text-[#146B5B]">
                          <User className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-xs font-black text-[#1F2933]">Account Profile</p>
                          <p className="text-[11px] text-[#667085]">Sign in to access your journeys</p>
                        </div>
                      </div>
                    </div>
                    <div className="p-3 space-y-2">
                      <button
                        onClick={() => {
                          navigate('/login');
                          setShowDropdown(false);
                        }}
                        className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-[#146B5B] hover:bg-[#0f5447] text-white text-xs font-black transition shadow-2xs cursor-pointer"
                      >
                        Sign In
                      </button>
                      <button
                        onClick={() => {
                          navigate('/signup');
                          setShowDropdown(false);
                        }}
                        className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl border border-[#D9DED9] hover:bg-gray-50 text-[#1F2933] text-xs font-black transition cursor-pointer"
                      >
                        Sign Up
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {/* Mobile menu panel */}
        {showMobileMenu && (
          <div className="md:hidden pb-4 border-t border-[#D9DED9] bg-white">
            <div className="mt-3 space-y-1">
              {menuItems.map((item) => {
                if (item.action) {
                  return (
                    <button
                      key={item.name}
                      onClick={item.action}
                      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-bold text-[#667085] hover:bg-gray-50"
                    >
                      <item.icon className="h-4.5 w-4.5 text-[#146B5B]" />
                      {item.name}
                    </button>
                  );
                }
                return (
                  <Link
                    key={item.name}
                    to={item.path}
                    onClick={() => setShowMobileMenu(false)}
                    className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-bold text-[#667085] hover:bg-gray-50 no-underline"
                  >
                    <item.icon className="h-4.5 w-4.5 text-[#146B5B]" />
                    {item.name}
                  </Link>
                );
              })}

              {!user && (
                <div className="pt-3 px-4 border-t border-[#D9DED9] space-y-2">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-[#667085]">Profile Options</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        navigate('/login');
                        setShowMobileMenu(false);
                      }}
                      className="flex-1 py-2.5 px-3 rounded-xl bg-[#146B5B] text-white text-xs font-black text-center shadow-xs cursor-pointer"
                    >
                      Sign In
                    </button>
                    <button
                      onClick={() => {
                        navigate('/signup');
                        setShowMobileMenu(false);
                      }}
                      className="flex-1 py-2.5 px-3 rounded-xl border border-[#D9DED9] bg-white text-[#1F2933] text-xs font-black text-center cursor-pointer"
                    >
                      Sign Up
                    </button>
                  </div>
                </div>
              )}

              {user && (
                <div className="pt-2 border-t border-[#D9DED9]">
                  <button
                    onClick={handleLogout}
                    className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-bold text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <LogOut className="h-4.5 w-4.5" />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* MY SAVED TRIPS MODAL OVERLAY */}
      {showMyTrips && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1F2933]/55 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-[#D9DED9] overflow-hidden flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between bg-white border-b border-[#D9DED9] p-4 shrink-0">
              <div className="flex items-center gap-2">
                <Briefcase className="h-4.5 w-4.5 text-[#146B5B]" />
                <h3 className="text-base font-black text-[#1F2933]">My Saved Trips</h3>
              </div>
              <button
                onClick={() => setShowMyTrips(false)}
                className="p-1 rounded-full hover:bg-gray-50 transition"
              >
                <X className="h-4.5 w-4.5 text-[#667085]" />
              </button>
            </div>

            {user ? (
              <div className="px-4 py-2.5 bg-[#EEF6F3] border-b border-[#D9DED9] flex items-center justify-between text-xs">
                <span className="font-bold text-[#146B5B] flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {user.name}
                </span>
                <span className="text-[#667085] font-semibold">
                  {tripsList.length} search{tripsList.length === 1 ? '' : 'es'} saved
                </span>
              </div>
            ) : (
              <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center justify-between text-xs">
                <span className="text-amber-800 font-semibold">Sign in to save search history to your account</span>
                <button
                  onClick={() => { setShowMyTrips(false); navigate('/login'); }}
                  className="font-bold text-[#146B5B] hover:underline cursor-pointer"
                >
                  Sign In
                </button>
              </div>
            )}

            <div className="p-4 overflow-y-auto space-y-3 flex-1">
              {tripsList.length === 0 ? (
                <div className="py-10 text-center space-y-1">
                  <p className="text-sm font-bold text-[#1F2933]">No trips saved yet</p>
                  <p className="text-xs text-[#667085]">
                    {user
                      ? 'Searched journeys will automatically appear here on your account.'
                      : 'Searched journeys will appear here. Sign in to sync across devices.'}
                  </p>
                </div>
              ) : (
                tripsList.map((trip) => (
                  <div
                    key={trip.id}
                    onClick={() => handleSelectTrip(trip)}
                    className="p-3 bg-white hover:bg-gray-50 border border-[#D9DED9] rounded-lg flex items-center justify-between cursor-pointer transition"
                  >
                    <div>
                      <p className="text-sm font-bold text-[#1F2933]">{trip.from} ➔ {trip.to}</p>
                      <p className="text-xs text-[#667085] font-semibold mt-0.5">📅 {trip.date}</p>
                    </div>
                    <button
                      onClick={(e) => handleDeleteTrip(trip.id, e)}
                      className="p-2 text-[#667085] hover:text-red-600 rounded-md hover:bg-red-50 transition"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* SAVED ROUTES MODAL OVERLAY */}
      {showSavedRoutes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1F2933]/55 backdrop-blur-sm p-3 sm:p-4 animate-fadeIn">
          <div className={`w-full ${selectedRouteDetail ? 'max-w-3xl' : 'max-w-md'} bg-white rounded-2xl shadow-2xl border border-[#D9DED9] overflow-hidden flex flex-col max-h-[90vh] transition-all duration-200`}>
            
            {/* Modal Header */}
            <div className="flex items-center justify-between bg-white border-b border-[#D9DED9] p-4 shrink-0">
              <div className="flex items-center gap-2">
                {selectedRouteDetail ? (
                  <button
                    type="button"
                    onClick={() => setSelectedRouteDetail(null)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#D9DED9] bg-white px-2.5 py-1 text-xs font-bold text-[#146B5B] hover:bg-[#EEF6F3] transition cursor-pointer"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                ) : (
                  <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#EEF6F3] text-[#146B5B]">
                    <Bookmark className="h-4.5 w-4.5" />
                  </div>
                )}
                <h3 className="text-base font-black text-[#1F2933]">
                  {selectedRouteDetail ? 'Saved Journey Details' : 'Saved Routes'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => { setShowSavedRoutes(false); setSelectedRouteDetail(null); }}
                className="p-1 rounded-full hover:bg-gray-100 transition cursor-pointer"
                aria-label="Close modal"
              >
                <X className="h-4.5 w-4.5 text-[#667085]" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 bg-[#FAFCFB]">
              {selectedRouteDetail ? (
                <div className="space-y-4">
                  {/* Action banner */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white border border-[#D9DED9] p-3 shadow-2xs">
                    <div>
                      <span className="text-[11px] uppercase font-extrabold tracking-wider text-[#146B5B]">Saved Route Itinerary</span>
                      <p className="text-sm font-black text-[#1F2933]">{selectedRouteDetail.from} ➔ {selectedRouteDetail.to}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSavedRoutes(false);
                        const params = new URLSearchParams({
                          from: selectedRouteDetail.from,
                          to: selectedRouteDetail.to,
                          date: selectedRouteDetail.date || todayLocalIso()
                        });
                        navigate(`/search-results?${params.toString()}`);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#146B5B] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#0f5447] transition shadow-xs cursor-pointer"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Live Route Search
                    </button>
                  </div>

                  {/* Render the full JourneyCard or RouteCard with breakdown */}
                  {selectedRouteDetail.journey ? (
                    <JourneyCard
                      journey={selectedRouteDetail.journey}
                      index={1}
                      from={selectedRouteDetail.from}
                      to={selectedRouteDetail.to}
                      initialShowDetails={true}
                    />
                  ) : selectedRouteDetail.route ? (
                    <RouteCard
                      route={selectedRouteDetail.route}
                      initialShowDetails={true}
                    />
                  ) : (
                    <div className="py-8 text-center space-y-2">
                      <p className="text-sm font-semibold text-[#1F2933]">Cached journey breakdown is not available for this legacy entry.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setShowSavedRoutes(false);
                          const params = new URLSearchParams({
                            from: selectedRouteDetail.from,
                            to: selectedRouteDetail.to,
                            date: selectedRouteDetail.date || todayLocalIso()
                          });
                          navigate(`/search-results?${params.toString()}`);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[#146B5B] px-4 py-2 text-xs font-bold text-white hover:bg-[#0f5447] transition cursor-pointer"
                      >
                        Search live route now
                      </button>
                    </div>
                  )}
                </div>
              ) : routesList.length === 0 ? (
                <div className="py-12 text-center space-y-2">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-[#667085] mb-1">
                    <Bookmark className="h-6 w-6" />
                  </div>
                  <p className="text-base font-bold text-[#1F2933]">No routes saved yet</p>
                  <p className="text-xs text-[#667085] max-w-xs mx-auto">Click "Save" on any route card in your search results to keep it here with its complete breakdown and stops.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-xs font-semibold text-[#667085] px-1">Click a route to view its full breakdown &amp; details:</p>
                  {routesList.map((route) => (
                    <div
                      key={route.id}
                      onClick={() => handleSelectRoute(route)}
                      className="p-3.5 bg-white hover:bg-[#F5FAF8] border border-[#D9DED9] hover:border-[#146B5B] rounded-xl flex items-center justify-between cursor-pointer transition shadow-2xs group"
                    >
                      <div className="min-w-0 pr-3 space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-[#1F2933] group-hover:text-[#146B5B] transition truncate">
                            {route.from} ➔ {route.to}
                          </p>
                          <span className="text-[10px] uppercase font-extrabold tracking-wider px-1.5 py-0.5 rounded-md bg-[#EEF6F3] text-[#146B5B]">
                            View details →
                          </span>
                        </div>
                        <p className="text-xs text-[#667085] font-semibold flex items-center gap-2">
                          <span>⏱ {Math.floor(route.duration / 60)}h {route.duration % 60}m</span>
                          <span>•</span>
                          <span>🔄 {route.transfers === 0 ? 'Direct' : `${route.transfers} Transfer${route.transfers === 1 ? '' : 's'}`}</span>
                          {route.price && (
                            <>
                              <span>•</span>
                              <span className="font-bold text-[#1F2933]">{route.price}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => handleDeleteRoute(route.id, e)}
                          title="Remove saved route"
                          aria-label="Remove saved route"
                          className="p-2 text-[#667085] hover:text-red-600 rounded-lg hover:bg-red-50 transition cursor-pointer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
