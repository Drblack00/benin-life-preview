// ============================================================
// Benin Life — multiplayer game server
// Real-time life simulator on a real map of Benin City, Nigeria.
//
// Systems:
// - Accounts (bcrypt, lockout), live movement + chat (WebSocket)
// - Jobs, food, fun, education, sleep, housing/rent (game-day loop)
// - Elections: weekly Governor votes — run, vote, govern
// - Businesses: buy shops, earn daily income
// - Bank: savings with interest, loans with interest
// - Vehicles: keke/car = faster movement (server-validated)
// - Street runs: risky hustle — police wahala, fines, detention
// - Dice betting (fictional currency)
// - DMs: private player messages; player profiles
// - Admin API: players, chat, broadcast, ban, election control
// - PostgreSQL in production (DATABASE_URL), SQLite locally
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDb, dbMode, getPlayerByName, getPlayerById, createPlayer,
  saveGame, countAdmins, listPlayers, setBanned, setAdmin,
  addChat, recentChat, getBusiness, createBusiness, listBusinesses,
  currentElection, createElection, closeElection, lastWinner,
  addCandidate, listCandidates, hasVoted, castVote, topCandidate,
  addDm, dmThreads, dmHistory, unreadDmCount, markDmRead,
  getMeta, setMeta, bumpVisits,
  addFriendRequest, respondFriendRequest, removeFriend, listFriendships, areFriends,
  createRoom, listRooms, getRoom, deleteRoom, joinRoom, leaveRoom, roomMembers,
  roomMemberRole, setRoomMuted, playerRooms,
  listFurniture, placedFurnitureKeys, addFurniture, getFurniture, setFurniturePlaced, deleteFurniture,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'benin-life-dev-secret-change-me';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using dev default. Set it in production!');
}
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const BOUNDS = { latMin: 6.27, latMax: 6.43, lngMin: 5.56, lngMax: 5.67 };
const BASE_MAX_SPEED_MPS = 250; // anti-cheat baseline (foot)
const DAY_MS = 5 * 60 * 1000;
const SAVE_MS = 30 * 1000;
const ELECTION_DAYS = 7; // game days per election cycle
const RUN_FEE = 50000;

// ---------------- Game data: real Benin City coordinates ----------------
const ZONES = {
  ring:    { name: 'Ring Road',        lat: 6.3345,  lng: 5.6040,  r: 700, color: '#f59e0b', icon: '🛣️' },
  oba:     { name: 'Oba Market',       lat: 6.33458, lng: 5.61977, r: 600, color: '#d97706', icon: '🧺' },
  newbenin:{ name: 'New Benin Market', lat: 6.34993, lng: 5.63147, r: 700, color: '#7c3aed', icon: '🏬' },
  uniben:  { name: 'UNIBEN',           lat: 6.40009, lng: 5.60915, r: 900, color: '#0284c7', icon: '🎓' },
  zoo:     { name: 'Ogba Zoo',         lat: 6.3056,  lng: 5.59444, r: 700, color: '#16a34a', icon: '🦁' },
  kada:    { name: 'Kada Plaza',       lat: 6.31537, lng: 5.6277,  r: 600, color: '#db2777', icon: '🎬' },
  housing: { name: 'GRA Housing',      lat: 6.32424, lng: 5.6196,  r: 700, color: '#0f766e', icon: '🏠' },
  palace:  { name: 'Oba Palace',       lat: 6.3312,  lng: 5.6165,  r: 500, color: '#b91c1c', icon: '👑' },
  igun:    { name: 'Igun Street',      lat: 6.3285,  lng: 5.6110,  r: 450, color: '#92400e', icon: '🔨' },
  ekiosa:  { name: 'Ekiosa Market',    lat: 6.3205,  lng: 5.6135,  r: 550, color: '#ea580c', icon: '🛍️' },
  museum:  { name: 'National Museum',  lat: 6.3355,  lng: 5.6015,  r: 400, color: '#0891b2', icon: '🏛️' },
  stadium: { name: 'Ogbemudia Stadium',lat: 6.3290,  lng: 5.5830,  r: 600, color: '#15803d', icon: '⚽' },
  hospital:{ name: 'Central Hospital', lat: 6.3385,  lng: 5.6140,  r: 450, color: '#dc2626', icon: '🏥' },
  airport: { name: 'Benin Airport',    lat: 6.3040,  lng: 5.5770,  r: 650, color: '#0369a1', icon: '✈️' },
  sapele:  { name: 'Sapele Road',      lat: 6.2910,  lng: 5.6280,  r: 650, color: '#65a30d', icon: '🛣️' },
  ugbowo:  { name: 'Ugbowo',           lat: 6.3850,  lng: 5.6020,  r: 600, color: '#4f46e5', icon: '🏘️' },
  ekenwan: { name: 'Ekenwan Campus',   lat: 6.2880,  lng: 5.5900,  r: 600, color: '#2563eb', icon: '📚' },
};
const SPAWN = { lat: 6.3345, lng: 5.6040 };

const JOBS = {
  porter: { name: 'Market Porter',  zone: 'oba',      pay: 2500, energy: 25, cd: 30 },
  keke:   { name: 'Keke Driver',    zone: 'ring',     pay: 4000, energy: 30, cd: 60 },
  shop:   { name: 'Shop Assistant', zone: 'newbenin', pay: 3500, energy: 25, cd: 45 },
  intern: { name: 'Graduate Intern',zone: 'uniben',   pay: 6000, energy: 30, cd: 90, cert: true },
  guide:  { name: 'Palace Tour Guide', zone: 'palace', pay: 4500, energy: 25, cd: 60 },
  caster: { name: 'Bronze Caster',  zone: 'igun',     pay: 5500, energy: 35, cd: 90 },
  trader: { name: 'Market Trader',  zone: 'ekiosa',   pay: 3800, energy: 25, cd: 45 },
  medic:  { name: 'Ward Assistant', zone: 'hospital', pay: 5800, energy: 30, cd: 90 },
  grounds:{ name: 'Stadium Groundskeeper', zone: 'stadium', pay: 4200, energy: 30, cd: 60 },
  aporter:{ name: 'Airport Porter', zone: 'airport',  pay: 5200, energy: 30, cd: 75 },
  pos:    { name: 'POS Agent',      zone: 'sapele',   pay: 4800, energy: 20, cd: 60 },
  cafe:   { name: 'Cyber Café Attendant', zone: 'ugbowo', pay: 4300, energy: 20, cd: 60 },
  tutor:  { name: 'Campus Tutor',   zone: 'ekenwan',  pay: 5000, energy: 25, cd: 75 },
  mguide: { name: 'Museum Guide',   zone: 'museum',   pay: 4600, energy: 20, cd: 60 },
  zookeeper: { name: 'Zoo Keeper Assistant', zone: 'zoo', pay: 4200, energy: 25, cd: 60 }, // item 34: fills jobless Ogba Zoo (additive constant, no DB change)
  ticketseller: { name: 'Zoo Ticket Seller', zone: 'zoo', pay: 3000, energy: 20, cd: 45 }, // item 115: second job at Ogba Zoo, additive constant, no DB change
  usher:    { name: 'Cinema Usher', zone: 'kada', pay: 3600, energy: 20, cd: 45 }, // item 41: fills jobless Kada Plaza (additive constant, no DB change)
  popcornseller: { name: 'Kada Popcorn Seller', zone: 'kada', pay: 3300, energy: 20, cd: 45 }, // item 123: second job at Kada Plaza, additive constant, no DB change
  caretaker:{ name: 'Estate Caretaker', zone: 'housing', pay: 4800, energy: 25, cd: 60 }, // item 46: fills last jobless zone (GRA Housing), additive constant, no DB change
  vendor:   { name: 'Stadium Food Vendor', zone: 'stadium', pay: 4400, energy: 25, cd: 60 }, // item 58: second job at Ogbemudia Stadium, additive constant, no DB change
  taxidriver: { name: 'Airport Taxi Driver', zone: 'airport', pay: 5600, energy: 30, cd: 75 }, // item 65: second job at Benin Airport, additive constant, no DB change
  guard:    { name: 'Campus Security Guard', zone: 'ekenwan', pay: 4600, energy: 25, cd: 60 }, // item 72: second job at Ekenwan Campus, additive constant, no DB change
  giftshop: { name: 'Museum Gift Shop Attendant', zone: 'museum', pay: 4000, energy: 20, cd: 45 }, // item 75: second job at National Museum, additive constant, no DB change
  conductor:{ name: 'Ring Road Bus Conductor', zone: 'ring', pay: 3800, energy: 25, cd: 45 }, // item 84: second job at Ring Road, additive constant, no DB change
  stallassistant: { name: 'Oba Market Stall Assistant', zone: 'oba', pay: 3200, energy: 20, cd: 45 }, // item 85: second job at Oba Market, additive constant, no DB change
  cashier: { name: 'New Benin Market Cashier', zone: 'newbenin', pay: 3700, energy: 20, cd: 45 }, // item 92: second job at New Benin, additive constant, no DB change
  loader: { name: 'Ekiosa Market Loader', zone: 'ekiosa', pay: 3400, energy: 20, cd: 45 }, // item 95: second job at Ekiosa Market, additive constant, no DB change
  groundskeeper: { name: 'Palace Grounds Keeper', zone: 'palace', pay: 4100, energy: 25, cd: 60 }, // item 101: second job at Oba Palace, additive constant, no DB change
  recordsclerk: { name: 'Hospital Records Clerk', zone: 'hospital', pay: 3900, energy: 20, cd: 45 }, // item 105: second job at Central Hospital, additive constant, no DB change
  shopattendant: { name: 'Sapele Road Shop Attendant', zone: 'sapele', pay: 3600, energy: 20, cd: 45 }, // item 112: second job at Sapele Road, additive constant, no DB change
  libraryassistant: { name: 'UNIBEN Library Assistant', zone: 'uniben', pay: 4300, energy: 25, cd: 60 }, // item 125: second job at UNIBEN, additive constant, no DB change
  polisher: { name: 'Igun Bronze Polisher', zone: 'igun', pay: 3900, energy: 25, cd: 60 }, // item 132: second job at Igun Street, additive constant, no DB change
  bronzeapprentice: { name: 'Igun Bronze Apprentice', zone: 'igun', pay: 3500, energy: 20, cd: 45 }, // item 195: third job at Igun Street, additive constant, no DB change
  cafewaiter: { name: 'Ugbowo Hostel Café Waiter', zone: 'ugbowo', pay: 3500, energy: 20, cd: 45 }, // item 135: second job at Ugbowo, additive constant, no DB change
  gatesecurity: { name: 'GRA Gate Security', zone: 'housing', pay: 4200, energy: 25, cd: 60 }, // item 141: second job at GRA Housing, additive constant, no DB change
  gardener: { name: 'GRA Gardener', zone: 'housing', pay: 3800, energy: 20, cd: 45 }, // item 201: third job at GRA Housing, additive constant, no DB change
  merchseller: { name: 'Stadium Merch Seller', zone: 'stadium', pay: 3600, energy: 20, cd: 45 }, // item 145: third job at Ogbemudia Stadium, additive constant, no DB change
  cafeassistant: { name: 'Museum Café Assistant', zone: 'museum', pay: 3500, energy: 20, cd: 45 }, // item 151: third job at National Museum, additive constant, no DB change
  trafficwarden: { name: 'Ring Road Traffic Warden', zone: 'ring', pay: 3900, energy: 25, cd: 60 }, // item 155: third job at Ring Road, additive constant, no DB change
  deliveryrider: { name: 'Sapele Road Delivery Rider', zone: 'sapele', pay: 4000, energy: 20, cd: 45 }, // item 161: third job at Sapele Road, additive constant, no DB change
  checkin: { name: 'Airport Check-in Assistant', zone: 'airport', pay: 5400, energy: 25, cd: 60 }, // item 166: third job at Benin Airport, additive constant, no DB change
  fruitseller: { name: 'New Benin Fruit Seller', zone: 'newbenin', pay: 3400, energy: 20, cd: 45 }, // item 172: third job at New Benin, additive constant, no DB change
  bookshopclerk: { name: 'Ugbowo Bookshop Clerk', zone: 'ugbowo', pay: 3700, energy: 20, cd: 45 }, // item 175: third job at Ugbowo, additive constant, no DB change
  pharmacyassistant: { name: 'Hospital Pharmacy Assistant', zone: 'hospital', pay: 4100, energy: 20, cd: 45 }, // item 181: third job at Central Hospital, additive constant, no DB change
  zoogiftshop: { name: 'Zoo Gift Shop Clerk', zone: 'zoo', pay: 3200, energy: 20, cd: 45 }, // item 185: third job at Ogba Zoo, additive constant, no DB change
  shuttledriver: { name: 'UNIBEN Campus Shuttle Driver', zone: 'uniben', pay: 4500, energy: 25, cd: 60 }, // item 191: third job at UNIBEN, additive constant, no DB change
  librarian: { name: 'Ekenwan Campus Librarian', zone: 'ekenwan', pay: 4400, energy: 25, cd: 60 }, // item 205: third job at Ekenwan Campus, additive constant, no DB change
  fishseller: { name: 'Ekiosa Fish Seller', zone: 'ekiosa', pay: 3600, energy: 20, cd: 45 }, // item 215: third job at Ekiosa Market, additive constant, no DB change
  cinemacleaner: { name: 'Kada Cinema Cleaner', zone: 'kada', pay: 3100, energy: 20, cd: 45 }, // item 221: third job at Kada Plaza, additive constant, no DB change
  spiceseller: { name: 'Oba Market Spice Seller', zone: 'oba', pay: 3400, energy: 20, cd: 45 }, // item 225: third job at Oba Market, additive constant, no DB change
  palacedrummer: { name: 'Palace Drummer', zone: 'palace', pay: 3800, energy: 20, cd: 45 }, // item 230: third job at Oba Palace, additive constant, no DB change
  groundcrew: { name: 'Airport Ground Crew', zone: 'airport', pay: 5000, energy: 25, cd: 60 }, // item 235: fourth job at Benin Airport, additive constant, no DB change
  zootourguide: { name: 'Zoo Tour Guide', zone: 'zoo', pay: 3800, energy: 20, cd: 45 }, // item 241: fourth job at Ogba Zoo, additive constant, no DB change
};

const FOOD = {
  mamaput:  { name: 'Mama Put', cost: 800,  hunger: 30, energy: 15, happy: 0 },
  suya:     { name: 'Suya',     cost: 1500, hunger: 35, energy: 0,  happy: 10 },
  shawarma: { name: 'Shawarma', cost: 2000, hunger: 40, energy: 20, happy: 5 },
  jollof:   { name: 'Party Jollof', cost: 1800, hunger: 45, energy: 10, happy: 8 },
  asun:     { name: 'Asun (Peppered Goat)', cost: 2500, hunger: 30, energy: 0, happy: 15 },
  banga:    { name: 'Banga Soup', cost: 2200, hunger: 50, energy: 15, happy: 5 },
  peppersoup:{ name: 'Pepper Soup', cost: 2800, hunger: 40, energy: 10, happy: 12 }, // item 38: existing eat flow, no DB change
  akara:    { name: 'Akara & Pap', cost: 1200, hunger: 25, energy: 5, happy: 5 }, // item 47: existing eat flow, no DB change
  cornpear: { name: 'Roasted Corn & Pear', cost: 900, hunger: 20, energy: 5, happy: 5 }, // item 57: existing eat flow, no DB change
  boli:     { name: 'Boli & Groundnut', cost: 1000, hunger: 22, energy: 5, happy: 8 }, // item 66: existing eat flow, no DB change
  ofada:    { name: 'Ofada & Ayamase', cost: 2000, hunger: 35, energy: 10, happy: 8 }, // item 76: existing eat flow, no DB change
  eba:      { name: 'Eba & Egusi', cost: 1500, hunger: 38, energy: 10, happy: 5 }, // item 86: existing eat flow, no DB change
  friedrice:{ name: 'Fried Rice & Chicken', cost: 1800, hunger: 42, energy: 10, happy: 8 }, // item 96: existing eat flow, no DB change
  nkwobi:   { name: 'Nkwobi', cost: 2200, hunger: 30, energy: 5, happy: 15 }, // item 102: existing eat flow, no DB change
  yamegg:   { name: 'Yam & Egg Sauce', cost: 1400, hunger: 30, energy: 8, happy: 6 }, // item 106: existing eat flow, no DB change
  moimoi:   { name: 'Moi Moi & Pap', cost: 1100, hunger: 26, energy: 5, happy: 5 }, // item 116: existing eat flow, no DB change
  poundedyam: { name: 'Pounded Yam & Vegetable Soup', cost: 2400, hunger: 45, energy: 10, happy: 6 }, // item 126: existing eat flow, no DB change
  beansdodo: { name: 'Beans & Dodo', cost: 1300, hunger: 28, energy: 5, happy: 6 }, // item 136: existing eat flow, no DB change
  catfishbbq: { name: 'Catfish Barbecue', cost: 2600, hunger: 38, energy: 5, happy: 12 }, // item 143: existing eat flow, no DB change
  snailpeppersoup: { name: 'Snail Pepper Soup', cost: 2000, hunger: 32, energy: 5, happy: 12 }, // item 146: existing eat flow, no DB change
  groundnutsoup: { name: 'Groundnut Soup & Semo', cost: 1900, hunger: 36, energy: 8, happy: 6 }, // item 153: existing eat flow, no DB change
  edikang: { name: 'Edikang Ikong', cost: 2300, hunger: 40, energy: 10, happy: 8 }, // item 156: existing eat flow, no DB change
  afang: { name: 'Afang Soup', cost: 2100, hunger: 34, energy: 8, happy: 10 }, // item 163: existing eat flow, no DB change
  starchowho: { name: 'Starch & Owho Soup', cost: 2400, hunger: 42, energy: 10, happy: 6 }, // item 167: existing eat flow, no DB change
  ukodo: { name: 'Ukodo (Yam Pepper Soup)', cost: 1900, hunger: 33, energy: 8, happy: 8 }, // item 176: existing eat flow, no DB change
  whiterice: { name: 'White Rice & Stew', cost: 1600, hunger: 32, energy: 8, happy: 6 }, // item 186: existing eat flow, no DB change
  coconutrice: { name: 'Coconut Rice', cost: 1700, hunger: 34, energy: 8, happy: 7 }, // item 196: existing eat flow, no DB change
  ewa: { name: 'Ewa Agoyin', cost: 1100, hunger: 28, energy: 5, happy: 6 }, // item 206: existing eat flow, no DB change
  ogbono: { name: 'Ogbono Soup', cost: 2000, hunger: 36, energy: 8, happy: 7 }, // item 216: existing eat flow, no DB change
  beansplantain: { name: 'Beans & Plantain', cost: 1200, hunger: 27, energy: 5, happy: 6 }, // item 226: existing eat flow, no DB change
  amala: { name: 'Amala & Ewedu', cost: 1600, hunger: 35, energy: 8, happy: 6 }, // item 236: existing eat flow, no DB change
};

const FUN = {
  zoo:    { name: 'Ogba Zoo visit', cost: 1500, happy: 25, energy: -10, zone: 'zoo' },
  cinema: { name: 'Kada Cinema',    cost: 2500, happy: 30, energy: 0, zone: 'kada' },
  match:  { name: 'Watch a Match',  cost: 2000, happy: 28, energy: 0, zone: 'stadium' },
  museum_tour: { name: 'Museum Tour', cost: 1200, happy: 20, energy: 0, zone: 'museum' },
  palace_tour: { name: 'Palace Tour', cost: 1500, happy: 22, energy: 0, zone: 'palace' },
  hostelparty: { name: 'Hostel Party', cost: 1800, happy: 26, energy: -5, zone: 'ugbowo' }, // item 39: existing fun flow, no DB change
  nightmarket: { name: 'Sapele Night Market stroll', cost: 1000, happy: 18, energy: 0, zone: 'sapele' }, // item 48: existing fun flow, no DB change
  airportview: { name: 'Airport Viewing Deck', cost: 1500, happy: 22, energy: 0, zone: 'airport' }, // item 56: existing fun flow, no DB change
  campushangout: { name: 'Campus Hangout', cost: 1200, happy: 20, energy: 0, zone: 'uniben' }, // item 67: existing fun flow, no DB change
  bargain:  { name: 'Oba Market Bargain Hunt', cost: 800, happy: 16, energy: 0, zone: 'oba' }, // item 77: existing fun flow, no DB change
  gallery:  { name: 'Igun Bronze Gallery Walk', cost: 1000, happy: 18, energy: 0, zone: 'igun' }, // item 87: existing fun flow, no DB change
  eveningstroll: { name: 'Ring Road Evening Stroll', cost: 900, happy: 15, energy: 0, zone: 'ring' }, // item 93: existing fun flow, no DB change
  ekiosagist: { name: 'Ekiosa Evening Gist', cost: 900, happy: 16, energy: 0, zone: 'ekiosa' }, // item 97: existing fun flow, no DB change
  grawalk: { name: 'GRA Evening Walk', cost: 700, happy: 14, energy: 0, zone: 'housing' }, // item 107: existing fun flow, no DB change
  newbeninshop: { name: 'New Benin Night Shopping', cost: 1100, happy: 17, energy: 0, zone: 'newbenin' }, // item 117: first fun at New Benin, existing fun flow, no DB change
  ekenwanview: { name: 'Ekenwan Campus Football Viewing', cost: 800, happy: 16, energy: 0, zone: 'ekenwan' }, // item 127: first fun at Ekenwan Campus, existing fun flow, no DB change
  ekenwanmovie: { name: 'Ekenwan Campus Movie Night', cost: 900, happy: 16, energy: 0, zone: 'ekenwan' }, // item 197: second fun at Ekenwan Campus, existing fun flow, no DB change
  hospitalsitout: { name: 'Hospital Garden Sit-out', cost: 500, happy: 12, energy: 0, zone: 'hospital' }, // item 133: first fun at Central Hospital, existing fun flow, no DB change
  zoopicnic: { name: 'Ogba Zoo Picnic', cost: 1000, happy: 18, energy: 0, zone: 'zoo' }, // item 137: second fun at Ogba Zoo, existing fun flow, no DB change
  zoofeeding: { name: 'Zoo Animal Feeding Experience', cost: 1500, happy: 21, energy: 0, zone: 'zoo' }, // item 202: third fun at Ogba Zoo, existing fun flow, no DB change
  kadaarcade: { name: 'Kada Arcade Games', cost: 1200, happy: 19, energy: 0, zone: 'kada' }, // item 142: second fun at Kada Plaza, existing fun flow, no DB change
  stadiumfan: { name: 'Stadium Fan Zone Cheer', cost: 1000, happy: 18, energy: 0, zone: 'stadium' }, // item 147: second fun at Ogbemudia Stadium, existing fun flow, no DB change
  palacegarden: { name: 'Palace Royal Garden Walk', cost: 1200, happy: 19, energy: 0, zone: 'palace' }, // item 152: second fun at Oba Palace, existing fun flow, no DB change
  museumsketch: { name: 'Museum Art Sketch Session', cost: 900, happy: 17, energy: 0, zone: 'museum' }, // item 157: second fun at National Museum, existing fun flow, no DB change
  grajog: { name: 'GRA Jogging Loop', cost: 600, happy: 13, energy: 0, zone: 'housing' }, // item 162: second fun at GRA Housing, existing fun flow, no DB change
  botanical: { name: 'UNIBEN Botanical Garden Walk', cost: 800, happy: 16, energy: 0, zone: 'uniben' }, // item 168: second fun at UNIBEN, existing fun flow, no DB change
  streetfootball: { name: 'Ugbowo Street Football', cost: 700, happy: 14, energy: 0, zone: 'ugbowo' }, // item 177: second fun at Ugbowo, existing fun flow, no DB change
  airportlounge: { name: 'Airport Lounge Chill', cost: 1300, happy: 19, energy: 0, zone: 'airport' }, // item 182: second fun at Benin Airport, existing fun flow, no DB change
  obamusic: { name: 'Oba Market Live Music', cost: 1200, happy: 19, energy: 0, zone: 'oba' }, // item 187: second fun at Oba Market, existing fun flow, no DB change
  sapelefoodtour: { name: 'Sapele Road Food Tour', cost: 1400, happy: 20, energy: 0, zone: 'sapele' }, // item 192: second fun at Sapele Road, existing fun flow, no DB change
  castingdemo: { name: 'Igun Bronze Casting Demo', cost: 1200, happy: 19, energy: 0, zone: 'igun' }, // item 207: second fun at Igun Street, existing fun flow, no DB change
  zoobird: { name: 'Zoo Bird Watching', cost: 1100, happy: 17, energy: 0, zone: 'zoo' }, // item 217: fourth fun at Ogba Zoo, existing fun flow, no DB change
  palacedrum: { name: 'Palace Drum Circle', cost: 1100, happy: 18, energy: 0, zone: 'palace' }, // item 222: third fun at Oba Palace, existing fun flow, no DB change
  ekiosadance: { name: 'Ekiosa Evening Dance', cost: 1000, happy: 17, energy: 0, zone: 'ekiosa' }, // item 227: second fun at Ekiosa Market, existing fun flow, no DB change
  ringwalk: { name: 'Ring Road Morning Walk', cost: 800, happy: 15, energy: 0, zone: 'ring' }, // item 231: second fun at Ring Road, existing fun flow, no DB change
  museumstory: { name: 'Museum Storytelling Evening', cost: 1000, happy: 17, energy: 0, zone: 'museum' }, // item 237: third fun at National Museum, existing fun flow, no DB change
  unibensports: { name: 'UNIBEN Sports Day', cost: 900, happy: 16, energy: 0, zone: 'uniben' }, // item 242: third fun at UNIBEN, existing fun flow, no DB change
};

const HOUSING = {
  'face-me': { name: 'Face-me-I-face-you', rent: 5000 },
  selfcon:   { name: 'Self-contain',       rent: 12000 },
  flat:      { name: '2-Bedroom Flat',     rent: 25000 },
  bridge:    { name: 'Under the Bridge',   rent: 0 },
};

const BIZ = {
  mamaput:  { name: 'Mama Put Spot', cost: 50000,  income: 3000,  icon: '🍲' },
  poskiosk: { name: 'POS Kiosk', cost: 60000, income: 3800, icon: '🏧' }, // item 59: between Mama Put (3000) and Phone Repair (5000), existing daily-income flow
  boutique: { name: 'Boutique',      cost: 150000, income: 8000,  icon: '👗' },
  phone:    { name: 'Phone Repair Shop', cost: 90000, income: 5000, icon: '📱' }, // item 16: income tier between Mama Put (3000) and Boutique (8000)
  barbing:  { name: 'Barbing Salon', cost: 120000, income: 6500, icon: '💈' }, // item 40: between Phone Repair (5000) and Boutique (8000)
  cyber:    { name: 'Cyber Café', cost: 180000, income: 10000, icon: '💻' }, // item 49: between Boutique (8000) and Lounge (20000)
  laundry:  { name: 'Laundry Service', cost: 250000, income: 13000, icon: '🧺' }, // item 68: between Cyber Café (10000) and Lounge (20000), existing daily-income flow
  grocery:  { name: 'Grocery Mini-Mart', cost: 200000, income: 11000, icon: '🛒' }, // item 88: between Cyber Café (10000) and Laundry (13000), existing daily-income flow
  carwash:  { name: 'Car Wash', cost: 220000, income: 12000, icon: '🚗' }, // item 118: between Grocery Mini-Mart (11000) and Laundry (13000), existing daily-income flow
  bookshop: { name: 'Bookshop & Stationery', cost: 280000, income: 14500, icon: '📚' }, // item 98: between Laundry (13000) and Pharmacy (16000), existing daily-income flow
  pharmacy: { name: 'Pharmacy', cost: 320000, income: 16000, icon: '💊' }, // item 78: between Laundry (13000) and Lounge (20000), existing daily-income flow
  supermarket: { name: 'Supermarket', cost: 350000, income: 18000, icon: '🏪' }, // item 128: between Pharmacy (16000) and Lounge (20000), existing daily-income flow
  restaurant: { name: 'Restaurant', cost: 380000, income: 19000, icon: '🍽️' }, // item 138: between Supermarket (18000) and Lounge (20000), existing daily-income flow
  bakery: { name: 'Bakery', cost: 365000, income: 18500, icon: '🍞' }, // item 158: between Supermarket (18000) and Restaurant (19000), existing daily-income flow
  furniture: { name: 'Furniture Shop', cost: 390000, income: 19500, icon: '🪑' }, // item 148: between Restaurant (19000) and Lounge (20000), existing daily-income flow
  eventhall: { name: 'Event Hall', cost: 395000, income: 19800, icon: '🎪' }, // item 169: between Furniture Shop (19500) and Lounge (20000), existing daily-income flow
  electronics: { name: 'Electronics Shop', cost: 300000, income: 15500, icon: '📺' }, // item 108: between Bookshop (14500) and Pharmacy (16000), existing daily-income flow
  lounge:   { name: 'Lounge & Bar',  cost: 400000, income: 20000, icon: '🍾' },
  hotel: { name: 'Hotel & Suites', cost: 450000, income: 22000, icon: '🏨' }, // item 178: new top tier above Lounge & Bar, existing daily-income flow
  mall: { name: 'Shopping Mall', cost: 500000, income: 24000, icon: '🏬' }, // item 188: new top tier above Hotel & Suites, existing daily-income flow
  fillingstation: { name: 'Filling Station', cost: 550000, income: 26000, icon: '⛽' }, // item 198: new top tier above Shopping Mall, existing daily-income flow
  resort: { name: 'Resort & Suites', cost: 600000, income: 28000, icon: '🏝️' }, // item 208: new top tier above Filling Station, existing daily-income flow
  techhub: { name: 'Tech Hub', cost: 650000, income: 30000, icon: '💻' }, // item 218: new top tier above Resort & Suites, existing daily-income flow
  apartment: { name: 'Apartment Complex', cost: 700000, income: 32000, icon: '🏢' }, // item 228: new top tier above Tech Hub, existing daily-income flow
  cinemacomplex: { name: 'Cinema Complex', cost: 750000, income: 34000, icon: '🎬' }, // item 238: new top tier above Apartment Complex, existing daily-income flow
};

const VEHICLES = {
  none: { name: 'Trek (on foot)', cost: 0,      mult: 1,   icon: '🚶' },
  keke: { name: 'Keke Napep',     cost: 80000,  mult: 1.6, icon: '🛺' },
  car:  { name: 'Toyota Camry',   cost: 300000, mult: 2.2, icon: '🚗' },
};

// Character customization (validated allowlists — never trust client input)
const AVATARS = ['🧑','👩','👨','🧔','👩‍🦰','🧑‍🦱','👩‍🦱','🧓','👵','🤠','😎','🦸','👷','🧕'];
const COLORS = ['#22d3ee','#f472b6','#a3e635','#fbbf24','#c084fc','#fb7185','#34d399','#60a5fa'];

// Owned property: one-time purchase, no daily rent, daily happiness bonus
const PROPERTIES = {
  selfcon_own: { name: 'Self-Contain (Owned)', price: 150000,  happy: 5,  icon: '🏠' },
  flat_own:    { name: '2-Bedroom Flat (Owned)', price: 400000, happy: 10, icon: '🏡' },
  duplex_own:  { name: 'Duplex in GRA (Owned)',  price: 1200000, happy: 15, icon: '🏘️' },
};

// Furniture: buy into inventory, place up to HOME_SLOTS in your home, each
// placed item has a concrete gameplay effect. Sell back at 50%.
const FURN = {
  bed:    { name: 'Comfy Bed',       price: 15000, icon: '🛏️', desc: 'Sleep restores +20 extra health' },
  fridge: { name: 'Fridge',          price: 20000, icon: '🧊', desc: 'Eating restores +15 extra hunger' },
  tv:     { name: 'Flat-screen TV',  price: 25000, icon: '📺', desc: 'Fun gives +10 extra happiness' },
  sofa:   { name: 'Sofa Set',        price: 18000, icon: '🛋️', desc: 'Fun gives +8 extra happiness' },
  gen:    { name: 'Generator',       price: 30000, icon: '🔌', desc: '+5 happiness every day (no more "up NEPA")' },
  ac:     { name: 'Air Conditioner', price: 45000, icon: '❄️', desc: 'Sleep: +20 health and +10 happiness' },
};
const HOME_SLOTS = 6;

const STUDY_COST = 5000;
const GOV_SALARY = 25000;
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'nigga', 'nigger', 'dick', 'pussy', 'asshole', 'bastard', 'whore', 'slut'];

// ---------------- Database ----------------
await initDb();
let chatMemory = (await recentChat()).map(r => ({ name: r.username, text: r.text, ts: Number(r.ts) }));

// ---------------- Helpers ----------------
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function inZone(p, key) {
  const z = ZONES[key];
  return haversineM(p.lat, p.lng, z.lat, z.lng) <= z.r;
}
function inBounds(lat, lng) {
  return lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lng >= BOUNDS.lngMin && lng <= BOUNDS.lngMax;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function clean(text) {
  let t = String(text || '').trim().slice(0, 200);
  for (const w of BAD_WORDS) t = t.replace(new RegExp(w, 'gi'), '***');
  return t;
}
function speedMultOf(p) { return (VEHICLES[p.vehicle] || VEHICLES.none).mult; }

// ---------------- Auth tokens ----------------
function signToken(id) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const body = `${id}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return Buffer.from(`${body}.${sig}`).toString('base64url');
}
function verifyToken(tok) {
  try {
    const s = Buffer.from(String(tok), 'base64url').toString('utf8');
    const parts = s.split('.');
    if (parts.length !== 3) return null;
    const [id, exp, sig] = parts;
    if (Date.now() > Number(exp)) return null;
    const good = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    return Number(id);
  } catch { return null; }
}
async function adminFromReq(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  const id = verifyToken(m[1]);
  if (!id) return null;
  const p = await getPlayerById(id);
  if (!p || !Number(p.is_admin) || Number(p.banned)) return null;
  return p;
}

// ---------------- App ----------------
const app = express();
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const authHits = new Map();
function authLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  authHits.set(ip, arr);
  if (arr.length > 10) return res.status(429).json({ error: 'Too many attempts, slow down.' });
  next();
}
const lockouts = new Map();
function lockCheck(name) {
  const l = lockouts.get(name);
  if (l && l.until > Date.now()) return Math.ceil((l.until - Date.now()) / 1000);
  return 0;
}
function lockFail(name) {
  const l = lockouts.get(name) || { count: 0, until: 0 };
  l.count += 1;
  if (l.count >= 5) { l.until = Date.now() + 15 * 60 * 1000; l.count = 0; }
  lockouts.set(name, l);
}

const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;

app.post('/api/register', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3-16 letters, numbers or _.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password: min 8 characters.' });
  if (await getPlayerByName(username)) return res.status(409).json({ error: 'Username taken.' });
  const avatar = AVATARS.includes(req.body.avatar) ? req.body.avatar : '🧑';
  const color = COLORS.includes(String(req.body.color || '').toLowerCase()) ? String(req.body.color).toLowerCase() : '#22d3ee';
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const makeAdmin = (await countAdmins()) === 0;
  const id = await createPlayer(username, hash, now, makeAdmin, avatar, color);
  res.json({ token: signToken(id), username, is_admin: makeAdmin });
});

app.post('/api/login', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const locked = lockCheck(username);
  if (locked) return res.status(429).json({ error: `Account locked. Try again in ${Math.ceil(locked / 60)} min.` });
  const row = await getPlayerByName(username);
  if (!row || !bcrypt.compareSync(password, row.pass_hash)) {
    lockFail(username);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (Number(row.banned)) return res.status(403).json({ error: 'This account is banned.' });
  lockouts.delete(username);
  await saveGame({ ...row, last_seen: Date.now() });
  res.json({ token: signToken(row.id), username: row.username, is_admin: !!Number(row.is_admin) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, online: online.size, day, db: dbMode() });
});

app.get('/api/stats', async (req, res) => {
  const visits = Number((await getMeta('visits')) || 0);
  const gov = governorId ? (await getPlayerById(governorId)) : null;
  res.json({ online: online.size, visits, governor: gov ? gov.username : null });
});

app.get('/api/config', (req, res) => {
  res.json({ mapsKey: MAPS_KEY, spawn: SPAWN, bounds: BOUNDS });
});

// ---------------- Admin API ----------------
async function requireAdmin(req, res, next) {
  const a = await adminFromReq(req);
  if (!a) return res.status(403).json({ error: 'Admin only.' });
  req.admin = a;
  next();
}
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  const rows = await listPlayers();
  const onlineIds = new Set(online.keys());
  res.json(rows.map(r => ({
    id: r.id, username: r.username, cash: Number(r.cash), energy: Number(r.energy),
    hunger: Number(r.hunger), happy: Number(r.happy), housing: r.housing,
    cert: Number(r.cert), lat: Number(r.lat), lng: Number(r.lng),
    vehicle: r.vehicle, savings: Number(r.savings), loan: Number(r.loan),
    is_admin: !!Number(r.is_admin), banned: !!Number(r.banned),
    online: onlineIds.has(r.id), last_seen: Number(r.last_seen),
  })));
});
app.get('/api/admin/chat', requireAdmin, async (req, res) => {
  const rows = await recentChat(200);
  res.json(rows.map(r => ({ username: r.username, text: r.text, ts: Number(r.ts) })));
});
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const text = clean(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message.' });
  broadcast({ t: 'sys', text: `📢 ${text}` });
  res.json({ ok: true });
});
app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const target = await getPlayerByName(String(req.body.username || '').trim());
  if (!target) return res.status(404).json({ error: 'Player not found.' });
  if (Number(target.is_admin)) return res.status(400).json({ error: 'Cannot ban an admin.' });
  const banned = !!req.body.banned;
  await setBanned(target.id, banned);
  const o = online.get(target.id);
  if (banned && o) { try { o.ws.close(4403, 'banned'); } catch {} }
  res.json({ ok: true, banned });
});
app.post('/api/admin/make-admin', requireAdmin, async (req, res) => {
  const target = await getPlayerByName(String(req.body.username || '').trim());
  if (!target) return res.status(404).json({ error: 'Player not found.' });
  await setAdmin(target.id, true);
  res.json({ ok: true });
});
app.get('/api/admin/election', requireAdmin, async (req, res) => {
  const el = await currentElection();
  res.json({ election: el, candidates: el ? await listCandidates(el.id) : [], governorId });
});
app.post('/api/admin/end-election', requireAdmin, async (req, res) => {
  await tallyElection(true);
  res.json({ ok: true, governorId });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------- Live state ----------------
const online = new Map();
let day = 1;
let dayStart = Date.now();
let election = null;
let governorId = 0;

// ---------------- Street finds (Pokémon-GO-style spawns) ----------------
const spawns = new Map(); // id -> {id,lat,lng,kind,icon,amount,expires}
let spawnSeq = 1;

// ---------------- Social: friends, rooms, mentions ----------------
const roomChats = new Map(); // roomId -> [{name,text,ts,gov}] (last 50)
const roomRead = new Map();  // `${pid}:${roomId}` -> ts last read
const PRESET_ROOMS = [
  { name: 'Hustle Talk', topic: 'Money moves & business gist', icon: '💼' },
  { name: 'Market Deals', topic: 'Buy & sell with players', icon: '🛒' },
  { name: 'Governance', topic: 'Elections, laws & city talk', icon: '🗳️' },
  { name: 'Street Gist', topic: 'Bants, vibes & randomness', icon: '🎲' },
];
async function seedRooms() {
  const existing = await listRooms();
  if (existing.length) return;
  for (const r of PRESET_ROOMS) await createRoom(r.name, r.topic, r.icon, 0);
  console.log('[rooms] seeded preset rooms');
}
function sendTo(pid, msg) {
  const o = online.get(pid);
  if (o && o.ws.readyState === 1) o.ws.send(JSON.stringify(msg));
}
// friends list enriched with live presence + location for the client
async function friendsFor(pid) {
  const list = await listFriendships(pid);
  return list.map(f => {
    const o = online.get(f.other_id);
    return { ...f, online: !!o, lat: o ? o.p.lat : null, lng: o ? o.p.lng : null };
  });
}
function roomHistory(roomId) {
  if (!roomChats.has(roomId)) roomChats.set(roomId, []);
  return roomChats.get(roomId);
}
async function roomListFor(pid) {
  const rooms = await listRooms();
  const mine = new Set(await playerRooms(pid));
  return Promise.all(rooms.map(async (r) => {
    const hist = roomHistory(r.id);
    const readTs = roomRead.get(`${pid}:${r.id}`) || 0;
    const unread = hist.filter(m => m.ts > readTs && m.name !== online.get(pid)?.p.username).length;
    return { ...r, members: Number(r.members), joined: mine.has(Number(r.id)), unread };
  }));
}
function notifyMentions(text, fromName, where) {  // where: {kind:'city'} or {kind:'room', roomId, roomName}
  const seen = new Set();
  for (const m of text.matchAll(/@([A-Za-z0-9_]{3,20})/g)) {
    const uname = m[1].toLowerCase();
    if (seen.has(uname)) continue;
    seen.add(uname);
    for (const o of online.values()) {
      if (o.p.username.toLowerCase() === uname && o.p.username !== fromName) {
        sendTo(o.p.id, {
          t: 'mention', from: fromName,
          where: where.kind === 'room' ? `room:${where.roomId}` : 'city',
          roomName: where.roomName || null,
          text: text.slice(0, 80),
        });
      }
    }
  }
}const SPAWN_KINDS = [
  { kind: 'cash', icon: '💵', w: 45 },
  { kind: 'snack', icon: '🍲', w: 20 },
  { kind: 'energy', icon: '🥤', w: 20 },
  { kind: 'airtime', icon: '📱', w: 8 }, // item 12: flip it for ₦400 cash
  { kind: 'fruit', icon: '🍊', w: 7 }, // item 12: fresh fruit, hunger +15
];
// ---------------- Daily quest (item 11): one per game day, server-paid ----------------
const QUESTS = [
  { kind: 'work', text: 'Work one shift anywhere', reward: 1500 },
  { kind: 'visit', zone: 'oba', text: 'Visit Oba Market', reward: 1200 },
  { kind: 'eat', text: 'Eat at any food stall', reward: 1000 },
  { kind: 'visit', zone: 'palace', text: 'Visit Oba Palace', reward: 1200 },
  { kind: 'work', text: 'Work one shift anywhere', reward: 1500 },
  { kind: 'visit', zone: 'zoo', text: 'Visit Ogba Zoo', reward: 1200 },
  { kind: 'eat', text: 'Eat at any food stall', reward: 1000 },
  { kind: 'visit', zone: 'uniben', text: 'Visit UNIBEN', reward: 1200 },
  { kind: 'visit', zone: 'housing', text: 'Visit GRA Housing', reward: 1200 }, // item 54: existing quest flow, no DB change
  { kind: 'visit', zone: 'ekenwan', text: 'Visit Ekenwan Campus', reward: 1200 }, // item 71: existing quest flow, no DB change
  { kind: 'visit', zone: 'museum', text: 'Visit National Museum', reward: 1200 }, // item 80: existing quest flow, no DB change
  { kind: 'visit', zone: 'igun', text: 'Visit Igun Street', reward: 1200 }, // item 91: existing quest flow, no DB change
  { kind: 'visit', zone: 'ekiosa', text: 'Visit Ekiosa Market', reward: 1200 }, // item 99: existing quest flow, no DB change
  { kind: 'visit', zone: 'hospital', text: 'Visit Central Hospital', reward: 1200 }, // item 111: existing quest flow, no DB change
  { kind: 'visit', zone: 'sapele', text: 'Visit Sapele Road', reward: 1200 }, // item 119: existing quest flow, no DB change
  { kind: 'visit', zone: 'ugbowo', text: 'Visit Ugbowo', reward: 1200 }, // item 129: existing quest flow, no DB change
  { kind: 'visit', zone: 'kada', text: 'Visit Kada Plaza', reward: 1200 }, // item 139: existing quest flow, no DB change
  { kind: 'visit', zone: 'stadium', text: 'Visit Ogbemudia Stadium', reward: 1200 }, // item 149: existing quest flow, no DB change
  { kind: 'visit', zone: 'airport', text: 'Visit Benin Airport', reward: 1200 }, // item 159: existing quest flow, no DB change
  { kind: 'visit', zone: 'newbenin', text: 'Visit New Benin Market', reward: 1200 }, // item 171: existing quest flow, no DB change
  { kind: 'visit', zone: 'ring', text: 'Visit Ring Road', reward: 1200 }, // item 180: existing quest flow, no DB change — completes visit coverage of all 17 zones
  { kind: 'fun', text: 'Have fun anywhere', reward: 1000 }, // item 190: existing quest flow + one checkQuest call in the fun handler, no DB change
  { kind: 'sleep', text: 'Sleep once to rest', reward: 1000 }, // item 200: existing quest flow + one checkQuest call in the sleep handler, no DB change
  { kind: 'study', text: 'Study once', reward: 1000 }, // item 209: existing quest flow + one checkQuest call in the study handler, no DB change
  { kind: 'save', text: 'Save ₦5,000 in the bank', reward: 1000 }, // item 240: existing quest flow + one checkQuest call in the deposit handler (≥₦5,000), no DB change
];
function questForDay(d) {
  const q = QUESTS[((d - 1) % QUESTS.length + QUESTS.length) % QUESTS.length];
  return { ...q, zoneName: q.zone ? ZONES[q.zone].name : null };
}
async function checkQuest(o, kind) {
  const p = o.p;
  if (o.questDay !== day) { o.questDay = day; o.questDone = false; }
  if (o.questDone) return;
  const q = questForDay(day);
  if (q.kind !== kind) return;
  if (q.kind === 'visit' && !inZone(p, q.zone)) return;
  o.questDone = true;
  p.cash += q.reward;
  await persist(o);
  pushYou(o, `📜 Daily quest done: ${q.text} — +₦${q.reward.toLocaleString()}`);
  send(o, { t: 'quest', quest: { ...q, done: true } });
}
// ---------------- City event of the day (item 17), XP/levels (item 15), achievements (item 18) ----------------
const EVENTS = [
  { id: 'market', name: 'Market Day', icon: '🛍️', desc: 'Stalls are buzzing — work pays +₦500 extra today.', workBonus: 500 },
  { id: 'owambe', name: 'Owambe Saturday', icon: '🎉', desc: 'Party mood — fun gives +5 extra happiness today.', funBonus: 5 },
  { id: 'rain', name: 'Rainy Day', icon: '🌧️', desc: 'Rainy-day appetite — eating restores +5 extra hunger today.', eatBonus: 5 },
  { id: 'nepa', name: 'NEPA Outage', icon: '💡', desc: 'Lights out — fun gives 5 less happiness today.', funBonus: -5 },
];
function eventForDay(d) { return EVENTS[((d - 1) % EVENTS.length + EVENTS.length) % EVENTS.length]; }
// Level n needs (n-1)*150 XP: Lv 2 at 150, Lv 3 at 300, ...
function levelFor(xp) { return 1 + Math.floor(Math.max(0, Number(xp) || 0) / 150); }
function gainXP(o, amt) {
  const old = levelFor(o.p.xp || 0);
  o.p.xp = (Number(o.p.xp) || 0) + amt;
  const nl = levelFor(o.p.xp);
  if (nl > old) sys(o, `🎉 Level ${nl}! You are growing in Benin City — keep hustling.`);
}
// Achievements are DERIVED from real player state (no new claims, no extra storage):
// First Shift = one shift's XP, Certified = UNIBEN cert, Homeowner = owned property,
// Business Owner = owns a business, Governor = current governor.
function achievementsFor(p, bizType, isGov) {
  return [
    { id: 'first_shift', icon: '💪', label: 'First Shift', earned: (Number(p.xp) || 0) >= 20 },
    { id: 'certified', icon: '🎓', label: 'Certified', earned: !!Number(p.cert) },
    { id: 'homeowner', icon: '🏠', label: 'Homeowner', earned: !!p.property && p.property !== 'none' },
    { id: 'biz', icon: '🏪', label: 'Business Owner', earned: !!bizType },
    { id: 'governor', icon: '👑', label: 'Governor', earned: !!isGov },
  ];
}
function pickSpawnKind() {
  let r = Math.random() * 100, acc = 0;
  for (const k of SPAWN_KINDS) { acc += k.w; if (r < acc) return k; }
  return SPAWN_KINDS[0];
}
function spawnTick() {
  const now = Date.now();
  for (const [id, s] of spawns) {
    if (s.expires < now) { spawns.delete(id); broadcast({ t: 'despawn', id }); }
  }
  if (spawns.size > 80) return;
  for (const o of online.values()) {
    const p = o.p;
    let near = 0;
    for (const s of spawns.values()) if (haversineM(p.lat, p.lng, s.lat, s.lng) < 800) near++;
    if (near >= 4) continue;
    const n = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 150 + Math.random() * 450; // meters from player
      const lat = p.lat + (dist * Math.cos(ang)) / 110540;
      const lng = p.lng + (dist * Math.sin(ang)) / (111320 * Math.cos(p.lat * Math.PI / 180));
      if (!inBounds(lat, lng)) continue;
      const kind = pickSpawnKind();
      const s = {
        id: spawnSeq++,
        lat: +lat.toFixed(6), lng: +lng.toFixed(6),
        kind: kind.kind, icon: kind.icon,
        amount: kind.kind === 'cash' ? 300 + Math.floor(Math.random() * 1200) : 0,
        expires: now + 180000,
      };
      spawns.set(s.id, s);
      broadcast({ t: 'spawn', s });
    }
  }
}

function pub(p) {
  return { id: p.id, name: p.username, lat: p.lat, lng: p.lng, housing: p.housing, gov: p.id === governorId, avatar: p.avatar || '🧑', color: p.color || '#22d3ee', vehicle: p.vehicle || 'none' };
}
function broadcast(msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const [id, o] of online) {
    if (id === exceptId) continue;
    if (o.ws.readyState === 1) o.ws.send(s);
  }
}
function send(o, msg) {
  if (o.ws.readyState === 1) o.ws.send(JSON.stringify(msg));
}
function sys(o, text) { send(o, { t: 'sys', text }); }
function pushYou(o, note) {
  const p = o.p;
  send(o, {
    t: 'you', cash: p.cash, energy: p.energy, hunger: p.hunger, happy: p.happy, health: p.health,
    housing: p.housing, property: p.property, cert: p.cert, lat: p.lat, lng: p.lng,
    xp: Number(p.xp) || 0, level: levelFor(p.xp),
    vehicle: p.vehicle, savings: p.savings, loan: p.loan,
    avatar: p.avatar, color: p.color, furniture: o.furn || [],
    speedMult: speedMultOf(p), detained: Date.now() < o.detainedUntil,
    gov: p.id === governorId, note: note || null,
  });
}
async function persist(o) {
  await saveGame({ ...o.p, last_seen: Date.now() });
}

// ---------------- Elections ----------------
async function tallyElection(forced) {
  const el = await currentElection();
  if (!el) return;
  const top = await topCandidate(el.id);
  const winnerId = top ? top.player_id : 0;
  await closeElection(el.id, winnerId || null);
  if (winnerId) {
    governorId = winnerId;
    await setMeta('governor_id', winnerId);
    const w = await getPlayerById(winnerId);
    broadcast({ t: 'sys', text: `👑 ${w ? w.username : 'Someone'} is the new Governor of Benin City!` });
    broadcast({ t: 'gov', id: winnerId, name: w ? w.username : '' });
  } else {
    broadcast({ t: 'sys', text: `🗳️ Election ended with no candidates. A new race begins!` });
  }
  election = await createElection(day, day + ELECTION_DAYS);
  broadcast({ t: 'election', ...(await electionState(null)) });
  // close campaign rooms from the finished race
  try {
    const rooms = await listRooms();
    for (const r of rooms) {
      if (Number(r.creator_id) !== 0 && r.icon === '📣' && /'s Campaign$/.test(r.name)) {
        await deleteRoom(Number(r.id));
        roomChats.delete(Number(r.id));
      }
    }
    for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
  } catch (e) { console.error('[campaign cleanup]', e.message); }
  console.log(`[election] #${el.id} closed, winner=${winnerId || 'none'}`);
}

async function electionState(playerId) {
  const el = await currentElection();
  if (!el) return { active: false };
  const candidates = await listCandidates(el.id);
  return {
    active: true, id: el.id,
    endsInDays: Math.max(0, el.end_day - day),
    candidates,
    voted: playerId ? await hasVoted(el.id, playerId) : false,
    running: playerId ? candidates.some(c => Number(c.player_id) === playerId) : false,
    governorId,
  };
}

// ---------------- Game actions (server-authoritative) ----------------
async function doAct(o, m) {
  const p = o.p;
  const now = Date.now();
  if (now < o.detainedUntil && !['chat'].includes(m.a)) {
    return sys(o, `⛓️ You're in detention for ${Math.ceil((o.detainedUntil - now) / 1000)}s. Sit this one out.`);
  }
  const cdLeft = (key) => {
    const until = o.cds[key] || 0;
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  };

  if (m.a === 'work') {
    const job = JOBS[m.job];
    if (!job) return sys(o, 'Unknown job.');
    if (!inZone(p, job.zone)) return sys(o, `Go to ${ZONES[job.zone].name} to work as ${job.name}.`);
    if (job.cert && !p.cert) return sys(o, 'You need a UNIBEN certificate for this job. Study at UNIBEN first.');
    const left = cdLeft('work:' + m.job);
    if (left) return sys(o, `Rest small — ${job.name} available in ${left}s.`);
    if (p.energy < job.energy) return sys(o, 'Too tired. Eat or sleep first.');
    o.cds['work:' + m.job] = now + job.cd * 1000;
    p.energy = clamp(p.energy - job.energy, 0, 100);
    const ev = eventForDay(day);
    const pay = job.pay + (ev.workBonus || 0);
    p.cash += pay;
    gainXP(o, 20);
    await persist(o);
    pushYou(o, `+₦${pay.toLocaleString()} — ${job.name} shift done 💪${ev.workBonus ? ` (${ev.name} +₦${ev.workBonus})` : ''}`);
    await checkQuest(o, 'work');
  }
  else if (m.a === 'eat') {
    const f = FOOD[m.item];
    if (!f) return sys(o, 'Unknown food.');
    if (p.cash < f.cost) return sys(o, "You can't afford that. Hustle first!");
    const evEat = eventForDay(day);
    p.cash -= f.cost;
    p.hunger = clamp(p.hunger + f.hunger + (evEat.eatBonus || 0), 0, 100);
    p.energy = clamp(p.energy + f.energy, 0, 100);
    p.happy = clamp(p.happy + f.happy, 0, 100);
    await persist(o);
    pushYou(o, `${f.name} devoured 😋${evEat.eatBonus ? ` (${evEat.name} +${evEat.eatBonus} hunger)` : ''}`);
    await checkQuest(o, 'eat');
  }
  else if (m.a === 'fun') {
    const f = FUN[m.what];
    if (!f) return sys(o, 'Unknown fun.');
    const zoneKey = f.zone || (m.what === 'zoo' ? 'zoo' : 'kada');
    if (!inZone(p, zoneKey)) return sys(o, `Go to ${ZONES[zoneKey].name} first.`);
    if (p.cash < f.cost) return sys(o, "You can't afford that.");
    const evFun = eventForDay(day);
    p.cash -= f.cost;
    p.happy = clamp(p.happy + f.happy + (evFun.funBonus || 0), 0, 100);
    p.energy = clamp(p.energy + f.energy, 0, 100);
    gainXP(o, 15);
    await persist(o);
    pushYou(o, `${f.name} — vibes restored ✨${evFun.funBonus ? ` (${evFun.name} ${evFun.funBonus > 0 ? '+' : ''}${evFun.funBonus} happy)` : ''}`);
    await checkQuest(o, 'fun'); // item 190: fun quest completes on any fun activity, existing quest flow
  }
  else if (m.a === 'study') {
    if (!inZone(p, 'uniben') && !inZone(p, 'ekenwan')) return sys(o, 'Go to UNIBEN (Ugbowo) or Ekenwan Campus to study.');
    if (p.cert) return sys(o, 'You already have your certificate.');
    const left = cdLeft('study');
    if (left) return sys(o, `Classes resume in ${left}s.`);
    if (p.cash < STUDY_COST) return sys(o, `Tuition is ₦${STUDY_COST.toLocaleString()}.`);
    o.cds.study = now + 60 * 1000;
    p.cash -= STUDY_COST;
    p.energy = clamp(p.energy - 15, 0, 100);
    p.cert = 1;
    gainXP(o, 40);
    await persist(o);
    pushYou(o, '🎓 Certificate earned! Graduate Intern unlocked.');
    await checkQuest(o, 'study'); // item 209: study quest completes on any study, existing quest flow
  }
  else if (m.a === 'sleep') {
    const left = cdLeft('sleep');
    if (left) return sys(o, `You just slept. (${left}s)`);
    o.cds.sleep = now + 60 * 1000;
    p.energy = 100;
    p.hunger = clamp(p.hunger - 15, 0, 100);
    await persist(o);
    pushYou(o, '😴 Fully rested.');
    await checkQuest(o, 'sleep'); // item 200: sleep quest completes on any sleep, existing quest flow
  }
  else if (m.a === 'rent') {
    const h = HOUSING[m.h];
    if (!h) return sys(o, 'Unknown housing.');
    if (!inZone(p, 'housing')) return sys(o, 'Go to the GRA Housing area to change housing.');
    p.housing = m.h;
    p.misses = 0;
    await persist(o);
    pushYou(o, `Moved to: ${h.name} 🏠`);
  }
  // ---------- Elections ----------
  else if (m.a === 'run') {
    const el = await currentElection();
    if (!el) return sys(o, 'No election running right now.');
    const cands = await listCandidates(el.id);
    if (cands.some(c => Number(c.player_id) === p.id)) return sys(o, 'You are already running.');
    if (p.cash < RUN_FEE) return sys(o, `Campaign fee is ₦${RUN_FEE.toLocaleString()}.`);
    p.cash -= RUN_FEE;
    await addCandidate(el.id, p.id);
    await persist(o);
    pushYou(o, `🗳️ You're on the ballot! Campaign across the city.`);
    broadcast({ t: 'sys', text: `🗳️ ${p.username} is running for Governor!` });
    // campaign room for this candidate
    try {
      const campId = await createRoom(`${p.username}'s Campaign`, `Campaign HQ — vote ${p.username} for Governor!`, '📣', p.id);
      await joinRoom(campId, p.id, 'owner');
      roomRead.set(`${p.id}:${campId}`, Date.now());
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    } catch (e) { console.error('[campaign room]', e.message); }
  }
  else if (m.a === 'vote') {
    const el = await currentElection();
    if (!el) return sys(o, 'No election running right now.');
    const cid = Number(m.candidate);
    const cands = await listCandidates(el.id);
    if (!cands.some(c => Number(c.player_id) === cid)) return sys(o, 'That candidate is not running.');
    if (await hasVoted(el.id, p.id)) return sys(o, 'You already voted in this election.');
    await castVote(el.id, p.id, cid);
    pushYou(o, '🗳️ Vote cast! Results at the end of the race.');
    send(o, { t: 'election', ...(await electionState(p.id)) });
  }
  else if (m.a === 'gov_broadcast') {
    if (p.id !== governorId) return sys(o, 'Only the Governor can do that.');
    const left = cdLeft('govbc');
    if (left) return sys(o, `Governor broadcast available in ${left}s.`);
    const text = clean(m.text);
    if (!text) return;
    o.cds.govbc = now + 24 * 3600 * 1000;
    broadcast({ t: 'sys', text: `👑 Governor ${p.username}: ${text}` });
  }
  // ---------- Business ----------
  else if (m.a === 'buy_biz') {
    const b = BIZ[m.biz];
    if (!b) return sys(o, 'Unknown business.');
    if (await getBusiness(p.id)) return sys(o, 'You already own a business. One empire at a time!');
    if (p.cash < b.cost) return sys(o, `You need ₦${b.cost.toLocaleString()} to open this.`);
    p.cash -= b.cost;
    await createBusiness(p.id, m.biz, now);
    await persist(o);
    send(o, { t: 'biz', biz: m.biz });
    pushYou(o, `${b.icon} You now own a ${b.name}! Income lands every game day.`);
  }
  // ---------- Bank ----------
  else if (m.a === 'bank') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0) return sys(o, 'Enter a valid amount.');
    if (m.op === 'deposit') {
      if (p.cash < amt) return sys(o, "You don't have that much cash.");
      p.cash -= amt; p.savings += amt;
      await persist(o);
      pushYou(o, `🏦 Deposited ₦${amt.toLocaleString()}. Savings earn 2%/day.`);
      if (amt >= 5000) await checkQuest(o, 'save'); // item 240: save quest completes on a ₦5,000+ deposit, existing quest flow
    } else if (m.op === 'withdraw') {
      if (p.savings < amt) return sys(o, "You don't have that much saved.");
      p.savings -= amt; p.cash += amt;
      await persist(o);
      pushYou(o, `🏦 Withdrew ₦${amt.toLocaleString()}.`);
    }
  }
  else if (m.a === 'loan') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0 || amt > 100000) return sys(o, 'Loans: ₦1 – ₦100,000.');
    if (p.loan > 0) return sys(o, 'Repay your current loan first.');
    p.loan = amt; p.cash += amt;
    await persist(o);
    pushYou(o, `🏦 Loan of ₦${amt.toLocaleString()} approved. 10% daily interest — don't play!`);
  }
  else if (m.a === 'repay') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0) return sys(o, 'Enter a valid amount.');
    if (p.loan <= 0) return sys(o, 'You have no loan.');
    const pay = Math.min(amt, p.loan, p.cash);
    if (pay <= 0) return sys(o, "You don't have the cash.");
    p.cash -= pay; p.loan -= pay;
    await persist(o);
    pushYou(o, p.loan > 0 ? `Repaid ₦${pay.toLocaleString()}. ₦${p.loan.toLocaleString()} left.` : '🎉 Loan fully repaid!');
  }
  // ---------- Vehicles ----------
  else if (m.a === 'buy_vehicle') {
    const v = VEHICLES[m.v];
    if (!v || m.v === 'none') return sys(o, 'Unknown vehicle.');
    if (p.vehicle === m.v) return sys(o, 'You already own this.');
    if (p.cash < v.cost) return sys(o, `You need ₦${v.cost.toLocaleString()}.`);
    p.cash -= v.cost;
    p.vehicle = m.v;
    await persist(o);
    pushYou(o, `${v.icon} ${v.name} acquired! You move ${v.mult}x faster.`);
  }
  // ---------- Street runs (crime risk) ----------
  else if (m.a === 'runs') {
    const left = cdLeft('runs');
    if (left) return sys(o, `Lay low for ${left}s.`);
    o.cds.runs = now + 120 * 1000;
    const r = Math.random();
    if (r < 0.60) {
      const gain = 3000 + Math.floor(Math.random() * 5000);
      p.cash += gain;
      p.energy = clamp(p.energy - 10, 0, 100);
      await persist(o);
      pushYou(o, `🏃 Street runs paid off: +₦${gain.toLocaleString()}. No wahala this time.`);
    } else if (r < 0.85) {
      await persist(o);
      pushYou(o, '👀 Police dey road — you dodge am. Nothing gained, nothing lost.');
    } else {
      if (p.cash >= 10000) {
        p.cash -= 10000;
        await persist(o);
        pushYou(o, '🚔 Police wahala! They seized ₦10,000 as "bail".');
      } else {
        o.detainedUntil = now + 3 * 60 * 1000;
        await persist(o);
        pushYou(o, '⛓️ Caught! 3 minutes detention. Think about your life choices.');
      }
    }
  }
  // ---------- Dice betting ----------
  else if (m.a === 'bet') {
    const amt = Math.floor(Number(m.amount));
    const pick = Math.floor(Number(m.pick));
    if (!amt || amt < 100 || amt > 10000) return sys(o, 'Stake: ₦100 – ₦10,000.');
    if (!pick || pick < 1 || pick > 6) return sys(o, 'Pick a number 1–6.');
    if (p.cash < amt) return sys(o, "You can't cover that stake.");
    p.cash -= amt;
    const roll = 1 + Math.floor(Math.random() * 6);
    if (roll === pick) {
      const win = amt * 5;
      p.cash += win;
      await persist(o);
      pushYou(o, `🎲 Rolled ${roll} — JACKPOT! +₦${win.toLocaleString()}`);
    } else {
      await persist(o);
      pushYou(o, `🎲 Rolled ${roll}, you picked ${pick}. Stake gone. Try again?`);
    }
  }
  else {
    sys(o, 'Unknown action.');
  }
}

async function chargeRent(o) {
  const p = o.p;
  const h = HOUSING[p.housing] || HOUSING['face-me'];
  if (h.rent === 0) return;
  if (p.cash >= h.rent) {
    p.cash -= h.rent;
    p.misses = 0;
    sys(o, `🏠 Rent paid: ₦${h.rent.toLocaleString()} (${h.name})`);
  } else {
    p.misses += 1;
    if (p.misses >= 3) {
      p.housing = 'bridge';
      p.misses = 0;
      p.happy = clamp(p.happy - 20, 0, 100);
      sys(o, '⚠️ EVICTED! 3 missed rents. You now sleep under the bridge. Hustle hard to recover.');
    } else {
      sys(o, `⚠️ Landlord is knocking! Rent missed (${p.misses}/3). Pay ₦${h.rent.toLocaleString()} soon.`);
    }
  }
  await persist(o);
  pushYou(o);
}

// Daily economy: business income, bank interest, loan interest, governor salary
async function runEconomy() {
  try {
    // businesses pay owners (online or not)
    for (const b of await listBusinesses()) {
      const def = BIZ[b.type];
      if (!def) continue;
      const owner = await getPlayerById(b.owner_id);
      if (!owner) continue;
      owner.cash = Number(owner.cash) + def.income;
      await saveGame(owner);
      const o = online.get(owner.id);
      if (o) {
        o.p.cash = owner.cash;
        pushYou(o, `${def.icon} ${def.name} earned you ₦${def.income.toLocaleString()} today.`);
      }
    }
    // bank interest + loan interest for everyone
    for (const r of await listPlayers()) {
      let dirty = false;
      const p = { ...r, cash: Number(r.cash), savings: Number(r.savings), loan: Number(r.loan) };
      if (p.savings > 0) {
        const interest = Math.floor(p.savings * 0.02);
        p.savings += interest; p.cash += 0; dirty = true;
        const o = online.get(p.id);
        if (o) { o.p.savings = p.savings; pushYou(o, `🏦 Savings interest: +₦${interest.toLocaleString()}`); }
      }
      if (p.loan > 0) {
        const interest = Math.ceil(p.loan * 0.10);
        p.loan += interest; dirty = true;
        const o = online.get(p.id);
        if (o) { o.p.loan = p.loan; sys(o, `🏦 Loan interest: +₦${interest.toLocaleString()} (now ₦${p.loan.toLocaleString()}). Repay am!`); }
      }
      if (dirty) await saveGame(p);
    }
    // governor salary
    if (governorId) {
      const g = await getPlayerById(governorId);
      if (g) {
        g.cash = Number(g.cash) + GOV_SALARY;
        await saveGame(g);
        const o = online.get(governorId);
        if (o) { o.p.cash = g.cash; pushYou(o, `👑 Governor salary: +₦${GOV_SALARY.toLocaleString()}`); }
      }
    }
  } catch (e) { console.error('[economy]', e.message); }
}

// ---------------- WebSocket ----------------
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const id = verifyToken(url.searchParams.get('token'));
  if (!id) { ws.close(4401, 'bad token'); return; }
  const row = await getPlayerById(id);
  if (!row) { ws.close(4401, 'no player'); return; }
  if (Number(row.banned)) { ws.close(4403, 'banned'); return; }

  const old = online.get(id);
  if (old) { try { old.ws.close(4409, 'new session'); } catch {} }

  const o = {
    ws,
    p: {
      ...row,
      cash: Number(row.cash), energy: Number(row.energy), hunger: Number(row.hunger),
      happy: Number(row.happy), health: Number(row.health ?? 100), lat: Number(row.lat), lng: Number(row.lng),
      misses: Number(row.misses), cert: Number(row.cert),
      is_admin: Number(row.is_admin), banned: Number(row.banned),
      vehicle: row.vehicle || 'none', savings: Number(row.savings) || 0,
      loan: Number(row.loan) || 0, dm_read_ts: Number(row.dm_read_ts) || 0, xp: Number(row.xp) || 0,
      avatar: AVATARS.includes(row.avatar) ? row.avatar : '🧑',
      color: COLORS.includes(String(row.color || '').toLowerCase()) ? String(row.color).toLowerCase() : '#22d3ee',
      property: PROPERTIES[row.property] ? row.property : 'none',
    },
    furn: await listFurniture(id).catch(() => []),
    lastMove: 0, lastChat: 0, lastPos: null, cds: {}, detainedUntil: 0,
    questDay: day, questDone: false,
  };
  if (!inBounds(o.p.lat, o.p.lng)) { o.p.lat = SPAWN.lat; o.p.lng = SPAWN.lng; }
  o.lastPos = { lat: o.p.lat, lng: o.p.lng, ts: Date.now() };
  online.set(id, o);
  const visits = await bumpVisits().catch(() => 0);
  console.log(`[+] ${row.username} connected (${online.size} online)`);

  const biz = await getBusiness(id);
  const govRow = governorId ? await getPlayerById(governorId) : null;

  send(o, {
    t: 'init',
    you: { ...pub(o.p), cash: o.p.cash, energy: o.p.energy, hunger: o.p.hunger, happy: o.p.happy, health: o.p.health, property: o.p.property, cert: o.p.cert, is_admin: !!o.p.is_admin, vehicle: o.p.vehicle, savings: o.p.savings, loan: o.p.loan, xp: o.p.xp, level: levelFor(o.p.xp), furniture: o.furn || [], speedMult: speedMultOf(o.p) },
    players: [...online.values()].filter(x => x.p.id !== id).map(x => pub(x.p)),
    day, endsIn: Math.max(0, DAY_MS - (Date.now() - dayStart)),
    chat: chatMemory.slice(-40),
    zones: ZONES, jobs: JOBS, food: FOOD, fun: FUN, housing: HOUSING, bounds: BOUNDS,
    bizTypes: BIZ, vehicles: VEHICLES,
    biz: biz ? biz.type : null,
    election: await electionState(id),
    governor: govRow ? { id: govRow.id, name: govRow.username } : null,
    unreadDm: await unreadDmCount(id),
    quest: { ...questForDay(day), done: false },
    event: eventForDay(day),
    visits,
    spawns: [...spawns.values()],
    friends: await friendsFor(id),
    rooms: await roomListFor(id),
  });
  broadcast({ t: 'join', p: pub(o.p) }, id);
  broadcast({ t: 'stats', online: online.size });
  setTimeout(() => { try { spawnTick(); } catch (e) { console.error('[spawn]', e.message); } }, 1500);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();

    if (m.t === 'move') {
      if (now - o.lastMove < 40) return;
      o.lastMove = now;
      if (now < o.detainedUntil) return send(o, { t: 'snap', lat: o.p.lat, lng: o.p.lng });
      const lat = Number(m.lat), lng = Number(m.lng);
      if (!isFinite(lat) || !isFinite(lng) || !inBounds(lat, lng)) return;
      const maxSpeed = BASE_MAX_SPEED_MPS * speedMultOf(o.p);
      const dt = Math.max(0.05, (now - o.lastPos.ts) / 1000);
      const d = haversineM(o.lastPos.lat, o.lastPos.lng, lat, lng);
      if (d / dt > maxSpeed) {
        send(o, { t: 'snap', lat: o.p.lat, lng: o.p.lng });
        return;
      }
      o.p.lat = lat; o.p.lng = lng;
      o.lastPos = { lat, lng, ts: now };
      broadcast({ t: 'mv', id, lat, lng }, id);
      checkQuest(o, 'visit').catch(e => console.error('[quest]', e.message));
    }
    else if (m.t === 'chat') {
      if (now - o.lastChat < 1200) return send(o, { t: 'err', text: 'Slow down on the chat.' });
      o.lastChat = now;
      const text = clean(m.text);
      if (!text) return;
      const entry = { name: o.p.username, text, ts: now, gov: o.p.id === governorId };
      chatMemory.push(entry);
      if (chatMemory.length > 60) chatMemory = chatMemory.slice(-60);
      await addChat(o.p.username, text, now).catch(e => console.error('[chat]', e.message));
      broadcast({ t: 'chat', id, ...entry, lat: o.p.lat, lng: o.p.lng });
      notifyMentions(text, o.p.username, { kind: 'city' });
    }
    else if (m.t === 'act') {
      await doAct(o, m).catch(e => { console.error('[act]', e.message); sys(o, 'Something went wrong, try again.'); });
    }
    else if (m.t === 'dm') {
      const toId = Number(m.to);
      const target = toId && toId !== o.p.id ? await getPlayerById(toId) : null;
      if (!target) return send(o, { t: 'err', text: 'Player not found.' });
      const text = clean(m.text);
      if (!text) return;
      await addDm(o.p.id, toId, text, now);
      const to = online.get(toId);
      if (to) {
        send(to, { t: 'dm', from: o.p.id, fromName: o.p.username, text, ts: now });
        send(to, { t: 'dm_unread', n: await unreadDmCount(toId) });
      }
      send(o, { t: 'dm_sent', to: toId });
    }
    else if (m.t === 'dm_threads') {
      send(o, { t: 'dm_threads', threads: await dmThreads(o.p.id) });
    }
    else if (m.t === 'dm_history') {
      const withId = Number(m.with);
      const other = withId ? await getPlayerById(withId) : null;
      if (!other) return;
      send(o, { t: 'dm_history', with: withId, withName: other.username, msgs: await dmHistory(o.p.id, withId) });
    }
    else if (m.t === 'dm_read') {
      o.p.dm_read_ts = now;
      await markDmRead(o.p.id, now);
      send(o, { t: 'dm_unread', n: 0 });
    }
    else if (m.t === 'collect') {
      const p = o.p;
      const s = spawns.get(Number(m.id));
      if (!s) return;
      if (Date.now() > s.expires) { spawns.delete(s.id); return; }
      if (haversineM(p.lat, p.lng, s.lat, s.lng) > 300) {
        sys(o, '📍 Too far — walk closer to grab it!');
        return;
      }
      spawns.delete(s.id);
      let msg;
      if (s.kind === 'cash') { p.cash += s.amount; msg = `💵 Street find! +₦${s.amount.toLocaleString()}`; }
      else if (s.kind === 'snack') { p.hunger = clamp(p.hunger + 25, 0, 100); msg = '🍲 Tasty street find! Hunger +25'; }
      else if (s.kind === 'airtime') { p.cash += 400; msg = '📱 Airtime find! Flipped it for +₦400'; }
      else if (s.kind === 'fruit') { p.hunger = clamp(p.hunger + 15, 0, 100); p.happy = clamp(p.happy + 5, 0, 100); msg = '🍊 Fresh fruit! Hunger +15, Happy +5'; }
      else { p.energy = clamp(p.energy + 25, 0, 100); msg = '🥤 Cold drink! Energy +25'; }
      await persist(o);
      pushYou(o, msg);
      broadcast({ t: 'despawn', id: s.id });
    }
    else if (m.t === 'profile') {
      const tp = await getPlayerById(Number(m.id));
      if (!tp) return;
      const tbiz = await getBusiness(tp.id);
      send(o, {
        t: 'profile',
        p: {
          id: tp.id, username: tp.username, cash: Number(tp.cash),
          housing: tp.housing, vehicle: tp.vehicle || 'none', cert: !!Number(tp.cert),
          biz: tbiz ? tbiz.type : null, gov: tp.id === governorId,
          xp: Number(tp.xp) || 0, level: levelFor(tp.xp),
          badges: achievementsFor(tp, tbiz ? tbiz.type : null, tp.id === governorId),
          online: online.has(tp.id),
        },
      });
    }
    // ---------------- Friends ----------------
    else if (m.t === 'friend_add') {
      const uname = String(m.username || '').trim();
      if (!uname) return;
      const target = await getPlayerByName(uname);
      if (!target) return sys(o, `No player named "${uname}".`);
      const res = await addFriendRequest(id, target.id);
      if (res === 'self') return sys(o, 'You cannot add yourself.');
      if (res === 'exists') return sys(o, 'Already friends or request pending.');
      if (res === 'accepted') {
        sys(o, `🤝 You and ${target.username} are now friends!`);
        sendTo(target.id, { t: 'sys', text: `🤝 You and ${o.p.username} are now friends!` });
        sendTo(target.id, { t: 'friends', friends: await friendsFor(target.id) });
      } else {
        sys(o, `🤝 Friend request sent to ${target.username}.`);
        sendTo(target.id, {
          t: 'friend_request',
          from: { id: o.p.id, username: o.p.username },
          friends: await friendsFor(target.id),
        });
      }
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    else if (m.t === 'friend_accept' || m.t === 'friend_decline') {
      const otherId = Number(m.playerId);
      const ok = await respondFriendRequest(id, otherId, m.t === 'friend_accept');
      if (!ok) return sys(o, 'No such request.');
      const other = await getPlayerById(otherId);
      const uname = other ? other.username : 'them';
      sys(o, m.t === 'friend_accept' ? `🤝 You are now friends with ${uname}!` : `Request from ${uname} declined.`);
      sendTo(otherId, {
        t: 'sys',
        text: m.t === 'friend_accept' ? `🤝 ${o.p.username} accepted your friend request!` : `😶 ${o.p.username} declined your friend request.`,
      });
      sendTo(otherId, { t: 'friends', friends: await friendsFor(otherId) });
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    else if (m.t === 'friend_remove') {
      const otherId = Number(m.playerId);
      await removeFriend(id, otherId);
      send(o, { t: 'friends', friends: await friendsFor(id) });
      sendTo(otherId, { t: 'friends', friends: await friendsFor(otherId) });
      sys(o, 'Friend removed.');
    }
    else if (m.t === 'friends') {
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    // ---------------- Rooms ----------------
    else if (m.t === 'rooms') {
      send(o, { t: 'rooms', rooms: await roomListFor(id) });
    }
    else if (m.t === 'create_room') {
      const name = clean(m.name).slice(0, 30);
      if (!name) return sys(o, 'Give the room a name.');
      const topic = clean(m.topic).slice(0, 80);
      const icon = String(m.icon || '💬').slice(0, 4);
      const roomId = await createRoom(name, topic, icon, id);
      await joinRoom(roomId, id, 'owner');
      roomRead.set(`${id}:${roomId}`, Date.now());
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
      send(o, { t: 'room_joined', roomId });
    }
    else if (m.t === 'join_room') {
      const roomId = Number(m.roomId);
      const room = await getRoom(roomId);
      if (!room) return sys(o, 'Room not found.');
      await joinRoom(roomId, id, 'member');
      roomRead.set(`${id}:${roomId}`, Date.now());
      send(o, { t: 'room_joined', roomId, history: roomHistory(roomId).slice(-50) });
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    }
    else if (m.t === 'leave_room') {
      const roomId = Number(m.roomId);
      await leaveRoom(roomId, id);
      send(o, { t: 'room_left', roomId });
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    }
    else if (m.t === 'room_chat') {
      const roomId = Number(m.roomId);
      const mem = await roomMemberRole(roomId, id);
      if (!mem) return sys(o, 'Join the room first.');
      if (Date.now() < mem.muted_until) return sys(o, '🔇 You are muted in this room.');
      if (now - o.lastChat < 1200) return send(o, { t: 'err', text: 'Slow down on the chat.' });
      o.lastChat = now;
      const text = clean(m.text);
      if (!text) return;
      const room = await getRoom(roomId);
      const entry = { name: o.p.username, text, ts: now, gov: o.p.id === governorId };
      const hist = roomHistory(roomId);
      hist.push(entry);
      if (hist.length > 50) hist.splice(0, hist.length - 50);
      const members = await roomMembers(roomId);
      for (const mb of members) {
        const mo = online.get(mb.player_id);
        if (mo && mo.ws.readyState === 1) {
          send(mo, { t: 'room_msg', roomId, ...entry });
          if (mb.player_id !== id) {
            const unread = hist.filter(x => x.ts > (roomRead.get(`${mb.player_id}:${roomId}`) || 0) && x.name !== mo.p.username).length;
            send(mo, { t: 'room_unread', roomId, unread });
          }
        }
      }
      notifyMentions(text, o.p.username, { kind: 'room', roomId, roomName: room ? room.name : '' });
    }
    else if (m.t === 'room_members') {
      const roomId = Number(m.roomId);
      const mem = await roomMemberRole(roomId, id);
      if (!mem) return;
      const members = await roomMembers(roomId);
      send(o, {
        t: 'room_members', roomId,
        members: members.map(x => ({ ...x, online: online.has(x.player_id) })),
      });
    }
    else if (m.t === 'room_read') {
      roomRead.set(`${id}:${Number(m.roomId)}`, Date.now());
    }
    else if (m.t === 'kick_room' || m.t === 'mute_room') {
      const roomId = Number(m.roomId);
      const targetId = Number(m.playerId);
      const mem = await roomMemberRole(roomId, id);
      const room = await getRoom(roomId);
      const isAdmin = !!o.p.is_admin;
      if (!mem || (mem.role !== 'owner' && !isAdmin)) return sys(o, 'Only the room owner can do that.');
      if (targetId === id) return sys(o, 'You cannot moderate yourself.');
      if (m.t === 'kick_room') {
        await leaveRoom(roomId, targetId);
        sendTo(targetId, { t: 'sys', text: `👢 You were kicked from "${room ? room.name : 'a room'}".` });
        sendTo(targetId, { t: 'room_left', roomId });
        sys(o, 'Member kicked.');
      } else {
        const mins = Math.max(1, Math.min(1440, Number(m.minutes) || 10));
        await setRoomMuted(roomId, targetId, Date.now() + mins * 60000);
        sendTo(targetId, { t: 'sys', text: `🔇 You are muted in "${room ? room.name : 'a room'}" for ${mins}m.` });
        sys(o, `Muted for ${mins}m.`);
      }
      const members = await roomMembers(roomId);
      for (const mb of members) sendTo(mb.player_id, {
        t: 'room_members', roomId,
        members: members.map(x => ({ ...x, online: online.has(x.player_id) })),
      });
    }
  });

  ws.on('close', () => {
    if (online.get(id) === o) {
      online.delete(id);
      persist(o).catch(e => console.error('[save]', e.message));
      broadcast({ t: 'leave', id });
      broadcast({ t: 'stats', online: online.size });
      console.log(`[-] ${o.p.username} left (${online.size} online)`);
    }
  });
});

// ---------------- Game loop ----------------
setInterval(async () => {
  if (Date.now() - dayStart >= DAY_MS) {
    day++;
    dayStart = Date.now();
    await Promise.all([...online.values()].map(o => chargeRent(o).catch(e => console.error('[rent]', e.message))));
    await runEconomy();
    const el = await currentElection();
    if (el && day >= el.end_day) await tallyElection(false);
    broadcast({ t: 'day', day, endsIn: DAY_MS, quest: { ...questForDay(day), done: false }, event: eventForDay(day) });
    console.log(`[day] Day ${day} — ${online.size} online`);
  }
}, 1000);

setInterval(() => {
  for (const o of online.values()) {
    const p = o.p;
    p.hunger = clamp(p.hunger - 3, 0, 100);
    if (p.hunger <= 0) {
      p.energy = clamp(p.energy - 5, 0, 100);
      p.happy = clamp(p.happy - 5, 0, 100);
    }
    persist(o).catch(e => console.error('[save]', e.message));
    pushYou(o);
  }
}, 60000);

setInterval(() => { for (const o of online.values()) persist(o).catch(e => console.error('[save]', e.message)); }, SAVE_MS);
setInterval(spawnTick, 45000);
setTimeout(spawnTick, 5000);

// ---------------- Boot ----------------
election = await currentElection();
if (!election) election = await createElection(1, 1 + ELECTION_DAYS);
governorId = Number((await getMeta('governor_id')) || 0);
await seedRooms().catch(e => console.error('[rooms]', e.message));

server.listen(PORT, () => {
  console.log(`🌆 Benin Life server live on port ${PORT} — Day ${day} — db: ${dbMode()} — maps: ${MAPS_KEY ? 'key set' : 'NO KEY (fallback map)'}`);
});
