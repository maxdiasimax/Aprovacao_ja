const mysql = require('mysql2');
require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'Maximus@1',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
    multipleStatements: true // Permitir múltiplas queries (útil para migrações)
};

// Pool será criado após garantir que o DB existe
let pool;
let initPromise = null;

const db = {};

// Função para garantir criação do banco e tabelas
function initDB() {
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        // 1. Conexão sem definir database para criar se não existir
        const connection = mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password
        });

        const dbName = process.env.DB_NAME || 'aprovacao_ja';

        connection.connect((err) => {
            if (err) {
                console.error("Erro ao conectar ao MySQL (Init):", err);
                return reject(err);
            }
            
            console.log(`Verificando banco de dados '${dbName}'...`);
            connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`, (err) => {
                if (err) {
                    console.error("Erro ao criar banco de dados:", err);
                    connection.end();
                    return reject(err);
                }

                console.log(`Banco '${dbName}' verificado/criado.`);
                connection.end();

                // 2. Criar Pool conectado ao database
                pool = mysql.createPool({ ...dbConfig, database: dbName });
                
                // 3. Rodar migrações de tabelas
                runMigrations(() => resolve());
            });
        });
    });
    
    return initPromise;
}

// Wrapper compatível com SQLite
db.run = function(sql, params, callback) {
    if (!pool) {
        // Se chamado antes do init, tenta inicializar ou aguardar
        if (!initPromise) initDB();
        initPromise.then(() => {
            db.run(sql, params, callback);
        }).catch(err => {
            if (callback) callback(err);
        });
        return;
    }

    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    pool.query(sql, params, function(err, results) {
        if (err) {
            if (callback) callback(err);
            return;
        }
        const context = {
            lastID: results ? results.insertId : 0,
            changes: results ? results.affectedRows : 0
        };
        if (callback) callback.call(context, null);
    });
};

db.get = function(sql, params, callback) {
    if (!pool) {
         if (!initPromise) initDB();
         initPromise.then(() => {
             db.get(sql, params, callback);
         }).catch(err => {
             if (callback) callback(err);
         });
         return;
    }

    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    // LIMIT 1 para garantir comportamento de .get()
    const sqlLimit = sql.match(/LIMIT\s+\d+/i) ? sql : sql + " LIMIT 1";
    
    pool.query(sqlLimit, params, function(err, results) {
        if (err) {
            if (callback) callback(err);
            return;
        }
        if (callback) callback(null, results ? results[0] : null);
    });
};

db.all = function(sql, params, callback) {
    if (!pool) {
         if (!initPromise) initDB();
         initPromise.then(() => {
             db.all(sql, params, callback);
         }).catch(err => {
             if (callback) callback(err);
         });
         return;
    }

    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    pool.query(sql, params, function(err, results) {
        if (err) {
            if (callback) callback(err);
            return;
        }
        if (callback) callback(null, results);
    });
};

// Migrações
const runMigrations = async (callback) => {
    const migrations = [
        `CREATE TABLE IF NOT EXISTS usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            usuario VARCHAR(255) UNIQUE NOT NULL,
            senha VARCHAR(255) NOT NULL,
            perfil ENUM('Admin', 'Aluno') DEFAULT 'Aluno',
            telefone VARCHAR(50),
            email VARCHAR(255),
            status ENUM('Ativo', 'Inativo') DEFAULT 'Ativo',
            vencimento DATE,
            data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS questoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            pergunta TEXT NOT NULL,
            resposta_detalhada TEXT,
            disciplina VARCHAR(255),
            banca VARCHAR(255),
            ano INT,
            tipo ENUM('MultiplaEscolha', 'CertoErrado'),
            opcoes_json TEXT,
            id_externo VARCHAR(255),
            resposta_correta TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS progresso (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT,
            questao_id INT,
            status ENUM('Novo', 'Acertado', 'Errei', 'Revisar') DEFAULT 'Novo',
            contagem_acertos INT DEFAULT 0,
            ultima_revisao TIMESTAMP NULL,
            proxima_revisao TIMESTAMP NULL,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
            FOREIGN KEY (questao_id) REFERENCES questoes(id)
        )`,
        `CREATE TABLE IF NOT EXISTS simulados (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT,
            data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            disciplina VARCHAR(255),
            banca VARCHAR(255),
            total_questoes INT,
            acertos INT,
            tempo_total INT,
            tempo_gasto INT,
            questoes_json TEXT,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        )`
    ];

    const tabelasParametros = [
        'param_disciplinas', 'param_bancas', 'param_instituicoes', 
        'param_cargos', 'param_anos', 'param_carreiras', 
        'param_areas_formacao', 'param_escolaridades', 'param_dificuldades'
    ];

    tabelasParametros.forEach(t => {
        migrations.push(`CREATE TABLE IF NOT EXISTS ${t} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(255) NOT NULL UNIQUE
        )`);
    });
    
    // Inserir Usuário Admin Padrão (se não existir)
    // bcrypt hash de admin123: $2b$10$XXXXXXXXXXXXXXXXXXXXXX (simplificado para exemplo, ideal usar lib)
    // Como o server.js já tem essa lógica, deixamos lá, mas cuidado com delay de inicialização.

    try {
        for (const sql of migrations) {
            await new Promise((resolve, reject) => {
                pool.query(sql, (err) => err ? reject(err) : resolve());
            });
        }
        console.log("Migrações MySQL concluídas.");
        if (callback) callback();
    } catch (err) {
        console.error("Erro na migração MySQL:", err);
        if (callback) callback(err); // Ensure callback is called even on error if possible
    }
};

db.serialize = function(cb) {
    initDB().then(() => {
        if (cb) cb();
    }).catch(err => {
        console.error("Falha no serialize/init:", err);
    });
};

module.exports = db;
