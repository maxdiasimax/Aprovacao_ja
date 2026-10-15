const dbAsync = require('./db_async');
const db = require('./database');

async function syncParams() {
    console.log("=== Sincronizando Parâmetros ===");
    
    // Aguardar inicialização
    await new Promise(r => setTimeout(r, 1000));

    try {
        // 1. Sincronizar Bancas
        const bancas = await dbAsync.all("SELECT DISTINCT banca FROM questoes WHERE banca IS NOT NULL AND banca != ''");
        console.log(`Encontradas ${bancas.length} bancas únicas.`);
        
        for (const b of bancas) {
            await dbAsync.run("INSERT IGNORE INTO param_bancas (nome) VALUES (?)", [b.banca]);
            process.stdout.write('.');
        }
        console.log("\nBancas sincronizadas.");

        // 2. Sincronizar Disciplinas
        const disciplinas = await dbAsync.all("SELECT DISTINCT disciplina FROM questoes WHERE disciplina IS NOT NULL AND disciplina != ''");
        console.log(`Encontradas ${disciplinas.length} disciplinas únicas.`);

        for (const d of disciplinas) {
            await dbAsync.run("INSERT IGNORE INTO param_disciplinas (nome) VALUES (?)", [d.disciplina]);
            process.stdout.write('.');
        }
        console.log("\nDisciplinas sincronizadas.");
        
        // 3. (Opcional) Ano
        const anos = await dbAsync.all("SELECT DISTINCT ano FROM questoes WHERE ano IS NOT NULL");
        // Anos as string for param_anos if it exists? The system usually treats 'ano' as integer in questoes but params are usually strings/names.
        // Let's check param_anos structure implicitly by inserting.
        // Assuming param_anos(nome) exists based on admin_parametros view.
        console.log(`Encontrados ${anos.length} anos únicos.`);
        for (const a of anos) {
             await dbAsync.run("INSERT IGNORE INTO param_anos (nome) VALUES (?)", [String(a.ano)]);
             process.stdout.write('.');
        }
        console.log("\nAnos sincronizados.");


    } catch (err) {
        console.error("Erro na sincronização:", err);
    }
    console.log("\nConcluído.");
    process.exit(0);
}

syncParams();
