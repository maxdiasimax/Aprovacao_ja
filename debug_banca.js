const dbAsync = require('./db_async');
const db = require('./database');

async function debugBanca() {
    console.log("=== Diagnóstico de Bancas ===");
    
    // Aguardar inicialização
    await new Promise(r => setTimeout(r, 1000));

    try {
        const bancasParams = await dbAsync.all("SELECT * FROM param_bancas");
        console.log(`\n[param_bancas] Total: ${bancasParams.length}`);
        console.table(bancasParams);

        const questoesBancas = await dbAsync.all("SELECT id, banca FROM questoes LIMIT 20");
        console.log(`\n[questoes] Amostra de 20:`);
        console.table(questoesBancas);

        // Verificar match
        let matchCount = 0;
        let mismatchCount = 0;
        const bancaNames = bancasParams.map(b => b.nome);
        
        for (const q of questoesBancas) {
            if (!q.banca) continue;
            if (bancaNames.includes(q.banca)) {
                matchCount++;
            } else {
                console.warn(`MISMATCH: Questão ${q.id} tem banca '${q.banca}' que NÃO existe em param_bancas.`);
                mismatchCount++;
            }
        }
        console.log(`\nMatches: ${matchCount}, Mismatches: ${mismatchCount}`);

    } catch (err) {
        console.error("Erro no diagnóstico:", err);
    }
    process.exit(0);
}

debugBanca();
