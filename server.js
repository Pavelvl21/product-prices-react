// server.js - Полный код с аутентификацией и белым списком email
import express from 'express';
import { createClient } from '@libsql/client';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://price-hunter-bel.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static('public'));

// --- Переменные окружения ---
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const MY_SECRET_KEY = process.env.SECRET_KEY; // Для управления белым списком
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET не задан!');
  process.exit(1);
}

// --- Подключение к Turso ---
let db;
try {
  db = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN,
  });
  console.log('✅ Turso клиент создан');
} catch (err) {
  console.error('❌ Ошибка создания клиента Turso:', err.message);
  process.exit(1);
}

// --- Инициализация таблиц ---
async function initTables() {
  try {
    // Таблица пользователей
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,  -- email
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица белого списка email
    await db.execute(`
      CREATE TABLE IF NOT EXISTS allowed_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица кодов товаров
    await db.execute(`
      CREATE TABLE IF NOT EXISTS product_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица истории цен
    await db.execute(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица информации о товарах
    await db.execute(`
      CREATE TABLE IF NOT EXISTS products_info (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_price REAL NOT NULL,
        last_update DATETIME DEFAULT CURRENT_TIMESTAMP,
        link TEXT,
        category TEXT,
        brand TEXT
      )
    `);
    
    console.log('✅ Все таблицы инициализированы');
  } catch (err) {
    console.error('❌ Ошибка инициализации таблиц:', err);
  }
}
initTables();

// --- Валидация email ---
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// --- Middleware для проверки JWT ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
};

// --- API: Регистрация (только для email из белого списка) ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body; // username = email

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  if (!validateEmail(username)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    // Проверяем, есть ли email в белом списке
    const allowedResult = await db.execute({
      sql: 'SELECT * FROM allowed_emails WHERE email = ?',
      args: [username]
    });

    if (allowedResult.rows.length === 0) {
      return res.status(403).json({ error: 'Регистрация для этого email не разрешена' });
    }

    // Проверяем, не зарегистрирован ли уже пользователь
    const userResult = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    if (userResult.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }

    // Хешируем пароль и создаём пользователя
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [username, passwordHash]
    });

    res.status(201).json({ message: 'Регистрация успешна' });

  } catch (err) {
    console.error('Ошибка при регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- API: Вход в систему ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Необходимо указать email и пароль' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ message: 'Вход выполнен успешно', token });

  } catch (err) {
    console.error('Ошибка при входе:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- API: Добавить email в белый список (только по секретному ключу) ---
app.post('/api/allowed-emails', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const { email } = req.body;

  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }

  try {
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });

    res.json({ message: 'Email добавлен в белый список' });

  } catch (err) {
    console.error('Ошибка при добавлении email:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- API: Получить список всех разрешённых email (только по секретному ключу) ---
app.get('/api/allowed-emails', async (req, res) => {
  const userKey = req.headers['x-secret-key'];
  if (!userKey || userKey !== MY_SECRET_KEY) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  try {
    const result = await db.execute('SELECT email, created_at FROM allowed_emails ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка при получении списка:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ВСЕ ОСТАЛЬНЫЕ API-ЭНДПОИНТЫ (защищены JWT) ---

// Получить все коды
app.get('/api/codes', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT code FROM product_codes ORDER BY created_at DESC');
    res.json(result.rows.map(row => row.code));
  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// Добавить код
app.post('/api/codes', authenticateToken, async (req, res) => {
  const { code } = req.body;
  
  if (!validateProductCode(code)) {
    return res.status(400).json({ error: 'Код должен содержать только цифры (до 12 символов)' });
  }

  try {
    const countResult = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const count = countResult.rows[0].count;

    if (count >= 5000) {
      return res.status(400).json({ error: 'Достигнут лимит в 5000 товаров' });
    }

    const insertResult = await db.execute({
      sql: 'INSERT INTO product_codes (code) VALUES (?) ON CONFLICT(code) DO NOTHING RETURNING code',
      args: [code]
    });

    if (insertResult.rows.length === 0) {
      return res.json({ message: 'Код уже существует', code });
    }

    console.log(`✅ Новый код добавлен: ${code}`);
    updatePricesForNewCode(code).catch(console.error);

    res.status(201).json({ message: 'Код добавлен', code });

  } catch (err) {
    console.error('Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Остальные эндпоинты (bulk, delete, products, stats) остаются без изменений ---
// (Я их пропускаю для краткости, но они должны быть здесь с authenticateToken)
