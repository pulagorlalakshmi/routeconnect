// Origin-destination pairs for the nationwide coverage regression (fixture timetable, see railFixture.js).
// [from, to, category]. Places are resolved to coordinates from the station / place reference, so the same points are
// used for every version of the planner being compared. Categories describe what the case is meant to exercise.
export const CASES = [
  // metropolitan and interstate connections
  ['Chennai', 'Vijayawada', 'interstate'], ['Chennai', 'Visakhapatnam', 'interstate'], ['Chennai', 'Kolkata', 'metro'],
  ['Chennai', 'Bhubaneswar', 'interstate'], ['Chennai', 'New Delhi', 'metro'], ['Chennai', 'Nagpur', 'interstate'],
  ['Chennai', 'Bhopal', 'interstate'], ['Chennai', 'Bengaluru', 'metro'], ['Chennai', 'Coimbatore', 'interstate'],
  ['Chennai', 'Madurai', 'regional'], ['Chennai', 'Thiruvananthapuram', 'interstate'], ['Chennai', 'Pune', 'interstate'],
  ['Chennai', 'Mumbai', 'metro'], ['Chennai', 'Tirupati', 'interstate'], ['Mumbai', 'Pune', 'metro'],
  ['Mumbai', 'Ahmedabad', 'metro'], ['Mumbai', 'Surat', 'interstate'], ['Mumbai', 'Vadodara', 'interstate'],
  ['Mumbai', 'Nagpur', 'interstate'], ['Mumbai', 'Kolkata', 'metro'], ['Mumbai', 'Bengaluru', 'metro'],
  ['Mumbai', 'Mangaluru', 'interstate'], ['Mumbai', 'Hubballi', 'interstate'], ['New Delhi', 'Lucknow', 'metro'],
  ['New Delhi', 'Kanpur', 'interstate'], ['New Delhi', 'Prayagraj', 'interstate'], ['New Delhi', 'Varanasi', 'interstate'],
  ['New Delhi', 'Kolkata', 'metro'], ['New Delhi', 'Jaipur', 'interstate'], ['New Delhi', 'Ajmer', 'interstate'],
  ['New Delhi', 'Ahmedabad', 'metro'], ['New Delhi', 'Amritsar', 'interstate'], ['New Delhi', 'Ludhiana', 'interstate'],
  ['New Delhi', 'Chandigarh', 'interstate'], ['New Delhi', 'Agra', 'interstate'], ['New Delhi', 'Bhopal', 'interstate'],
  ['New Delhi', 'Nagpur', 'interstate'], ['New Delhi', 'Hyderabad', 'metro'], ['Kolkata', 'Bhubaneswar', 'interstate'],
  ['Kolkata', 'Puri', 'interstate'], ['Kolkata', 'Ranchi', 'interstate'], ['Kolkata', 'Guwahati', 'interstate'],
  ['Kolkata', 'Raipur', 'interstate'], ['Kolkata', 'Nagpur', 'interstate'], ['Bengaluru', 'Hyderabad', 'metro'],
  ['Bengaluru', 'Pune', 'interstate'], ['Bengaluru', 'Hubballi', 'regional'], ['Bengaluru', 'Davanagere', 'regional'],
  ['Hyderabad', 'Nagpur', 'interstate'], ['Hyderabad', 'Vijayawada', 'interstate'], ['Hyderabad', 'Tirupati', 'interstate'],
  ['Hyderabad', 'Warangal', 'regional'], ['Kochi', 'Thiruvananthapuram', 'regional'], ['Kochi', 'Coimbatore', 'interstate'],
  ['Kochi', 'Chennai', 'interstate'], ['Thrissur', 'Kollam', 'regional'], ['Madurai', 'Tiruchirappalli', 'regional'],
  ['Madurai', 'Chennai', 'interstate'], ['Tirunelveli', 'Chennai', 'interstate'], ['Bhubaneswar', 'Puri', 'regional'],
  ['Bhubaneswar', 'Visakhapatnam', 'interstate'], ['Patna', 'Varanasi', 'interstate'], ['Lucknow', 'Varanasi', 'regional'],
  ['Ahmedabad', 'Jaipur', 'interstate'], ['Ahmedabad', 'Surat', 'regional'], ['Jaipur', 'Ajmer', 'regional'],
  ['Amritsar', 'Ludhiana', 'regional'], ['Guwahati', 'Siliguri', 'interstate'], ['Raipur', 'Nagpur', 'interstate'],
  ['Nagpur', 'Bhopal', 'interstate'], ['Bhopal', 'Agra', 'interstate'], ['Mumbai', 'Nashik', 'regional'],
  // intermediate-station journeys (both ends are mid-route stops)
  ['Nellore', 'Ongole', 'intermediate'], ['Warangal', 'Nagpur', 'intermediate'], ['Solapur', 'Pune', 'intermediate'],
  ['Erode', 'Salem', 'intermediate'], ['Rajahmundry', 'Visakhapatnam', 'intermediate'], ['Kottayam', 'Thrissur', 'intermediate'],
  ['Durg', 'Rourkela', 'intermediate'], ['Kharagpur', 'Cuttack', 'intermediate'], ['Davanagere', 'Miraj', 'intermediate'],
  ['Gaya', 'Dhanbad', 'intermediate'], ['Jolarpettai', 'Arakkonam', 'intermediate'], ['Udupi', 'Ratnagiri', 'intermediate'],
  // overnight / multi-day
  ['Chennai', 'Agra', 'overnight'], ['Mumbai', 'Rourkela', 'overnight'], ['Thiruvananthapuram', 'Chennai', 'overnight'],
  ['Kanyakumari', 'Chennai', 'overnight'], ['Guwahati', 'Kolkata', 'overnight'],
  // no direct train in the fixture: a change at a junction is needed (train -> train)
  ['Kolkata', 'Patna', 'via'], ['Bengaluru', 'Kolkata', 'via'], ['Thiruvananthapuram', 'Visakhapatnam', 'via'],
  ['Madurai', 'Bengaluru', 'via'], ['Amritsar', 'Jaipur', 'via'], ['Lucknow', 'Kolkata', 'via'],
  // Andhra Pradesh towns: bus (APSRTC timetable) + train
  ['Narasaraopet', 'Visakhapatnam', 'bus_train'], ['Chilakaluripet', 'Visakhapatnam', 'bus_train'],
  ['Kurnool', 'Visakhapatnam', 'bus_train'], ['Vinukonda', 'Chennai', 'bus_train'], ['Macherla', 'Chennai', 'bus_train'],
  ['Narasaraopet', 'Kolkata', 'bus_train'], ['Tenali', 'Nagpur', 'bus_train'],
  // a direct train should beat a mixed journey
  ['Vijayawada', 'Visakhapatnam', 'direct_beats_mixed'], ['Guntur', 'Ongole', 'direct_beats_mixed'],
  ['Vijayawada', 'Chennai', 'direct_beats_mixed'],
  // no nearby station / no known public-transport connection in the data
  ['Leh', 'New Delhi', 'no_station'], ['Gangtok', 'Kolkata', 'no_station'], ['Munnar', 'Kochi', 'no_station'],
  ['Shimla', 'Puri', 'no_connection'], ['Kozhikode', 'Mysuru', 'no_connection'], ['Dehradun', 'Panaji', 'no_connection']
];

// Railway stations acceptable as THE station for a multi-terminal city (a result boarding elsewhere is a resolution miss).
export const CITY_TERMINALS = {
  Chennai: ['MAS', 'MS', 'PER', 'TBM', 'MSB'],
  Mumbai: ['CSMT', 'LTT', 'MMCT', 'BDTS', 'DR', 'TNA', 'KYN', 'PNVL', 'BVI'],
  'New Delhi': ['NDLS', 'DLI', 'NZM', 'ANVT', 'DEE', 'DEC'],
  Kolkata: ['HWH', 'SDAH', 'KOAA', 'SHM'],
  Bengaluru: ['SBC', 'YPR', 'SMVB', 'KJM', 'BNC'],
  Hyderabad: ['SC', 'HYB', 'KCG', 'CHZ', 'LPI']
};
