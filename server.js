// server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose(); // Подключаем SQLite
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000; // Используем порт из окружения Render или 3000 локально

// --- Настройка middleware ---
// Разбираем входящие запросы с JSON-телом (важно для POST-запроса)
app.use(express.json());

// --- Подключение к базе данных и её инициализация ---
// База данных будет храниться в файле 'products.db' в корневой папке
const dbPath = path.join(__dirname, 'products.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        // Создаём таблицу, если её ещё нет
        db.run(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT, -- Уникальный ID записи
                product_id TEXT NOT NULL,             -- ID товара (из вашей системы)
                name TEXT NOT NULL,                    -- Название товара
                price REAL NOT NULL,                    -- Цена товара
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP -- Дата и время записи
            )
        `, (err) => {
            if (err) {
                console.error('Ошибка создания таблицы:', err.message);
            } else {
                console.log('Таблица "products" готова.');
            }
        });
    }
});

// --- Маршруты (Endpoints) API ---

// 1. POST-запрос для сохранения данных
// Пример: отправить JSON на http://localhost:3000/products
app.post('/products', (req, res) => {
    // Получаем данные из тела запроса
    const { product_id, name, price } = req.body;

    // Простейшая валидация: проверяем, что все поля на месте
    if (!product_id || !name || price === undefined) {
        return res.status(400).json({ error: 'Пожалуйста, укажите product_id, name и price.' });
    }

    // Вставка данных в базу
    const sql = `INSERT INTO products (product_id, name, price) VALUES (?, ?, ?)`;
    db.run(sql, [product_id, name, price], function(err) {
        if (err) {
            console.error('Ошибка при вставке данных:', err.message);
            return res.status(500).json({ error: 'Не удалось сохранить товар.' });
        }
        // Отправляем успешный ответ с ID созданной записи
        res.status(201).json({
            message: 'Товар успешно сохранён!',
            id: this.lastID // ID новой записи в таблице
        });
    });
});

// 2. GET-запрос для получения всех сохранённых данных
// Пример: открыть в браузере http://localhost:3000/products
app.get('/products', (req, res) => {
    const sql = `SELECT * FROM products ORDER BY created_at DESC`; // Сортируем от новых к старым

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Ошибка при чтении данных:', err.message);
            return res.status(500).json({ error: 'Не удалось получить список товаров.' });
        }
        // Отправляем массив товаров в формате JSON
        res.json(rows);
    });
});

// Корневой маршрут для простой проверки работы сервера
app.get('/', (req, res) => {
    res.send('Сервер работает! Используйте /products для работы с данными.');
});

// --- Запуск сервера ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
