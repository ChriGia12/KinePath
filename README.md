# KinePath

*[English version](README.en.md)*

Sito web che sostituisce la catena Rhino/Grasshopper per la **stampa 3D robotica a estrusione con KUKA**:

1. carichi un modello **mesh o BREP**,
2. il sito propone l'**orientamento** migliore; il **modo di stampa** lo scegli tu (default: contorno a strati),
3. calcola il **percorso che segue il contorno** del pezzo entro la tolleranza impostata (default 0,2 mm), strato per strato,
4. esporta il file **`.src` KUKA** con la stessa struttura di `Tavolino1.src` (INI, BASE/TOOL, I/O estrusore, `LIN … C_DIS`, spegnimento, homing).

Tutto gira nel browser (TypeScript + Three.js + WebAssembly): il modello non viene caricato su nessun server.

Il sito è in **italiano e inglese**: il pulsante EN / IT in alto a destra cambia la lingua di tutta la pagina (anche avvisi, note e orientamenti già calcolati) e la scelta resta salvata nel browser.

**Controlli prima dell'esportazione.** Il pulsante *Scarica .src* resta disattivato:
- mentre un calcolo è in corso o dopo qualsiasi modifica, finché l'ultimo calcolo non è finito (un risultato vecchio non è mai scaricabile);
- se un parametro è fuori dai valori ammessi ($VEL.CP, uscite ANOUT, n° di strati, posizione sicura e posa di homing entro i limiti degli assi, …): i parametri sono controllati *prima* del calcolo, quindi un valore eccessivo non lo avvia nemmeno;
- `BASE_DATA[1]`, `TOOL_DATA[11]` ed E1–E4 = 0 sono bloccati: sono le sole configurazioni di cui la simulazione e il controllo di raggiungibilità conoscono le misure;
- se il robot non raggiunge un punto del percorso o un punto intermedio dei LIN (campionati ogni 20 mm), o se un asse supera i limiti del KR16;
- se un punto del percorso scende sotto il piano di lavoro (lastra a Z 38 in BASE): non si può confermare;
- se un campo numerico è vuoto o non valido;
- se il percorso esce dal piano di lavoro in pianta, se con *inclina utensile* ci sono punti con pendenza lungo X non seguibile, o se nell'orientamento scelto il pezzo ha isole che partono nel vuoto o più del 2% di superficie in sbalzo oltre l'angolo critico: in questi casi serve una conferma esplicita, che si azzera a ogni modifica.

**Collisioni.** Il percorso viene rieseguito cordolo per cordolo: in ogni posa avambraccio, polso (A3–A6) e mandrino, campionati dalla geometria reale della cella, non devono toccare la lastra né il materiale già depositato (griglia di 4 mm; l'ugello, che tocca il cordolo per costruzione, è controllato solo contro la lastra). Le pose si controllano ogni 3 mm di percorso, anche dentro i LIN lunghi: un ostacolo a metà di un segmento con le estremità libere viene trovato. Lo stesso controllo vale per i movimenti PTP del programma: posizione sicura → primo punto, ultimo punto → posizione sicura e homing (interpolazione degli assi come fa il controller, una posa ogni 0,5° dell'asse che si muove di più). Una collisione blocca l'esportazione e i punti coinvolti compaiono in magenta nella vista.

**Pezzi da dividere.** Se un pezzo non si stampa senza supporti in nessun orientamento, il sito cerca da solo dove tagliarlo in due: prova piani trasversali ai tre lati del pezzo (dal 25 al 75% della lunghezza) e, per ogni pezzo, l'appoggio sul taglio o capovolto. Se trova un taglio con cui entrambi i pezzi passano i controlli (nessuna isola nel vuoto, sbalzi entro il limite), lo propone nella scheda Modello: dove tagliare (piano arancione nella vista), come appoggiare ciascun pezzo e con quale modo di stampa. *Dividi in 2 pezzi* applica tutto: due pezzi già orientati, stampati uno dopo l'altro. Un solido tagliato resta chiuso (il taglio diventa una faccia piana); un guscio aperto resta aperto. Se dividere non aiuta davvero, il sito non lo propone. Per i gusci aperti (una carena senza coperta) lo sbalzo conta in entrambi i versi: un guscio spesso un cordolo più piatto del limite cede, che la sua faccia guardi in alto o in basso.

**Taglio manuale.** La sezione *Taglia il pezzo* è sempre nella scheda Modello: si sceglie il piano (orizzontale, o verticale perpendicolare a X o a Y del piano di stampa) e la posizione con il cursore o in mm; il piano compare in arancione nella vista e *Taglia qui* divide il pezzo selezionato in due pezzi che restano orientati come prima (con un taglio orizzontale il pezzo sopra appoggia sul taglio). Dopo il taglio ogni pezzo tiene il suo verso solo se così si stampa senza supporti, altrimenti prende l'orientamento migliore; se i pezzi si sovrappongono o escono dal piano, il sito li ridistribuisce da solo sul piano (affiancati lungo Y, a 70 mm, su più colonne se serve, il gruppo centrato). Ogni pezzo si può poi orientare, posizionare o tagliare di nuovo, per stampare a parte le zone complicate.

**Taglia alla base (senza perdere niente).** Se il bordo aperto di un pezzo tocca il piano solo in parte (una carena capovolta, il cui bordo sale verso prua e poppa), la sezione di taglio propone *Taglia alla base* con l'altezza già calcolata: il pezzo viene tagliato lì, la parte sopra appoggia piana sul taglio e la fascia sotto viene capovolta sul taglio (il bordo curvo libero in alto) e stampata accanto. La mesh è stampata tutta, in due pezzi da incollare lungo il taglio, senza gradini né supporti.

**Verso di stampa.** Ogni giro chiuso è percorso sempre nello stesso verso (antiorario visto dall'alto), anche i fori e gli anelli che seguono la superficie: al cambio strato la rampa prosegue in avanti sul giro nuovo. Solo gli archi aperti (le sezioni di un guscio aperto) vanno avanti e indietro, perché altrimenti servirebbe un salto a vuoto a ogni strato; a fine arco l'ugello sale in verticale e ripercorre l'arco sopra all'indietro, senza sollevarsi. I collegamenti brevi vengono stampati quando restano sopra materiale stampato (dentro le sezioni chiuse, o lungo la fascia di un arco aperto o di un supporto, dello strato corrente o di quello sotto); dove la mesh ha un vuoto vero il robot salta, perché unire i due lati aggiungerebbe materiale che nella mesh non c'è.

**Inclinazione utensile lungo la parete** (tutti i modi tranne superficie): l'utensile si inclina come la parete che sta stampando, fino a *Inclinazione massima* (30° di default), così sugli sbalzi il cordolo viene spinto contro lo strato sotto invece di essere appoggiato nel vuoto. Le pareti verticali e i coperchi piani restano con l'utensile verticale, e la direzione è smussata lungo il percorso perché il polso giri gradualmente. Con A −180 / B 0 si può inclinare solo nel piano Y-Z: le pendenze lungo X vengono segnalate e richiedono conferma, come nel modo superficie.

**Zone a rischio.** Sul pezzo sono evidenziati in arancione le facce in sbalzo oltre l'angolo critico, in rosso il contorno delle isole che partono nel vuoto e in giallo le pareti più sottili di un cordolo (non verrebbero stampate). Si nascondono con la casella *Zone a rischio*.

**La mesh si stampa tutta.** Ogni strato stampa esattamente la sezione della mesh: niente base inventata sotto il pezzo, nessuna parte tagliata o scartata perché sottile o piccola (anche le isole troppo piccole per la serpentina vengono stampate con il loro contorno). Il sito può solo spostare o girare il pezzo e aggiungere supporti da staccare; se qualcosa non si può stampare lo segnala. *Contorno minimo* è 0 (stampa tutto): se lo alzi, i contorni esclusi vengono contati negli avvisi.

**Limiti.** Il controllo delle collisioni usa una campionatura della geometria (punti ogni 8 mm sul mandrino, 25 mm sul braccio) e non considera braccio superiore, base e tavole fuori dalla lastra. Il controllo dei LIN intermedi verifica il percorso geometrico programmato, non la traiettoria raccordata che il controller esegue con `C_DIS` (default, come Tavolino1): con `C_DIS` il robot non passa esattamente per ogni punto; l'opzione *Approssimazione LIN → Nessuna* fa fermare il robot su ogni punto. Prima della stampa il `.src` va comunque provato a vuoto o nella simulazione della cella reale.

## Cella fissa

All'apertura il sito mostra già la cella, che non si sposta e non si può eliminare:

- **KUKA KR16 R2010** posato dalla cinematica reale (assi ricavati dal CAD: A2 a 160/520 mm, braccio 980 mm, avambraccio 150/860 mm, flangia a 153,9 mm dal polso);
- **mandrino** montato sulla flangia: la sua punta coincide con `TOOL_DATA[11] = {X 372.65, Y 0, Z 78.111}`;
- **tavole e lastra** di lavoro (piano di stampa a Z 38 nel sistema BASE, 640 × 1350 mm).

La geometria viene da `BASE ROBOT.3dm` ed è salvata in `public/cell.bin` (≈2 MB). Per rigenerarla:

```bash
node scripts/build-cell.mjs "/percorso/BASE ROBOT.3dm"
```

Il robot sta nel mondo Rhino a (0, −1000, 0): il punto disegnato in `BASE ROBOT.3dm` spostato di −1000 in Y, al centro del tavolo come la BASE, con la base 32 mm sotto il piano superiore delle tavole. La BASE del post-processore Python (1448, −1000, 5) in coordinate mondo risulta quindi a (1448, 0, 5) rispetto al robot.

**Orientamento utensile.** L'asse del mandrino è l'asse Z del TCP, come calibrato sul robot: con A = −180°, B = 0° il parametro C inclina l'utensile (C 180 = verticale verso il basso, C 135 ≈ 45°, C 90 / 270 = orizzontale). Con A −180 / B 0 / C 180 il robot lavora in verticale sopra il punto. Il mandrino è montato con la piastra sulla faccia della flangia e l'asse parallelo a essa (sistema FLANGE KUKA: Z uscente dalla flangia, come in `TOOL_DATA` e nel disegno del layer Mandrino): con l'utensile verticale la flangia guarda di lato e il polso è piegato, come sul robot reale.

**Simulazione.** Il pulsante *▶ Simula* fa eseguire al robot i movimenti `LIN` del file `.src`, alla velocità reale ($VEL.CP) moltiplicata per 1–500×. Il percorso già eseguito è colorato, quello da eseguire resta grigio chiaro; sotto sono indicati la riga `LIN` corrente, le coordinate X/Y/Z/A/B/C scritte nel file e gli angoli A1–A6. Lo slider permette di andare a qualsiasi movimento, quello degli strati salta alla fine di uno strato. I movimenti PTP (cambio pezzo, cambio programma con i supporti a parte) sono animati negli assi, come li interpola il controller. Per ogni punto il sito risolve la cinematica inversa e segnala i punti fuori portata o oltre i limiti degli assi.

## Uso rapido

1. **Carica il pezzo**: una mesh o un BREP. Ogni file aggiunge un pezzo alla lista: i pezzi vengono stampati uno dopo l'altro, nell'ordine della lista, ognuno con il suo orientamento e la sua posizione (un nuovo pezzo si mette accanto agli altri a 70 mm, lo spazio per far passare il mandrino accanto a un pezzo già finito; se due pezzi si sovrappongono l'esportazione è bloccata finché non li separi). I pezzi si spostano **trascinandoli nella vista** (mentre li trascini compare il loro ingombro, verde se sta sul piano, rosso se esce); *Disponi sul piano* li rimette in ordine in qualsiasi momento. Clic su un pezzo della lista per modificarlo, ↑ ↓ per cambiare l'ordine di stampa, × per toglierlo. Da un `.3dm` con tutta la scena viene preso solo l'oggetto che sta sul piano di lavoro. **Scala**: sotto la lista, per il pezzo selezionato (×1000 per i file in metri, ×10 in centimetri, ×25,4 in pollici, o un valore qualsiasi); se un pezzo misura meno di 2 mm o più di 5 m il sito avvisa che l'unità è probabilmente sbagliata.
2. Il sito propone l'orientamento migliore del pezzo selezionato (sezione Orientamento); scegli il modo di stampa in *Stampa*.
3. **Posiziona pezzo**: clicca sulla lastra nell'anteprima per spostare il centro del pezzo selezionato; la rotazione sul piano è in *Robot KUKA e piano → Rotazione pezzo Z*.
4. **Punto iniziale**: clicca vicino al contorno dove vuoi che parta la stampa (punto azzurro).
5. **Scarica .src**. **Scheda PDF** apre una scheda riassuntiva (immagine, pezzi, esito di tutti i controlli, risultato, impostazioni) da stampare o salvare in PDF.

**Cambio pezzo.** Con più pezzi, finito un pezzo il sito spegne l'estrusore, sale in verticale con un LIN senza raccordo fino a 30 mm sopra quanto già stampato, si sposta sopra il pezzo successivo con un `PTP` e scende con un LIN dove la stampa riprende (estrusore riacceso). Anche questi PTP passano dal controllo collisioni, con l'interpolazione degli assi del controller.

**Modifica percorso.** Se il percorso calcolato non va bene in un punto, *Modifica percorso* (sotto la simulazione) permette di cambiarlo a mano: si indica un tratto dal LIN di inizio a quello di fine (*qui* prende il LIN mostrato dal cursore) e lo si stampa a estrusore spento o acceso, lo si sposta di ΔX/ΔY/ΔZ, oppure se ne tolgono i punti. *Annulla ultima* e *Togli tutte* tornano indietro. Le modifiche sono applicate al percorso finito **prima** dei controlli: portata, limiti degli assi e collisioni vengono rifatti sul percorso modificato, e il risultato avvisa che il pezzo stampato può non corrispondere più alla mesh. Valgono solo per il percorso su cui sono state fatte: se cambia (un'impostazione, l'orientamento, la posizione) vengono tolte e il sito lo dice. Non si applicano con i supporti in un file a parte.

**Progetti.** *Salva progetto* scarica un file `.kinepath` con i file originali dei pezzi, il loro orientamento e la posizione e tutte le impostazioni; *Apri progetto* (o trascinare il file sulla zona di caricamento) riporta il sito esattamente a quello stato.

## Formati supportati

| Formato | Come viene letto |
|---|---|
| STL, OBJ, PLY | loader Three.js (unità assunte in mm) |
| 3DM (Rhino) | rhino3dm: mesh, polisuperfici ed estrusioni (usa le mesh di render salvate nel file), SubD. Unità convertite in mm |
| STEP, IGES, BREP | OpenCascade (occt-import-js), tassellazione 0,1 mm |

Le librerie rhino3dm e OpenCascade sono servite dal sito stesso (`public/vendor`, copiate da `node_modules` a ogni build): l'importazione non usa CDN né rete.

> Polisuperfici `.3dm` senza mesh di render (file salvati con "Salva piccolo") non sono leggibili: apri il file in Rhino in vista ombreggiata e risalva, oppure esporta STEP.

## Come funziona

- **Slicing esatto**: ogni strato è l'intersezione del piano con la mesh; i segmenti vengono concatenati usando la topologia (spigoli condivisi), quindi i contorni sono chiusi e seguono la geometria reale. Semplificazione Douglas–Peucker con tolleranza impostabile (default 0,2 mm), opzionale suddivisione dei LIN troppo lunghi (come "Divide Length").
- **Orientamento**: prova ±X/±Y/±Z e le facce piane più grandi dell'inviluppo convesso. Punteggio su sbalzi oltre l'angolo critico, isole che partono nel vuoto, numero di contorni per strato (ogni contorno separato = stop dell'estrusore), superficie d'appoggio, altezza. Prima del punteggio ogni orientamento passa i controlli bloccanti (nessuna isola nel vuoto, sbalzi entro il 2%): quelli che non li superano sono segnati *non validi* e messi in fondo. Se nessuno è valido il sito lo dice e l'esportazione richiede la conferma.
- **Tre tipi di stampa**: *Contorno* (segue le pareti del pezzo), *Riempimento* (ogni strato pieno, a serpentina) e *Superficie* (serpentina sulla superficie superiore). Per il contorno, *Contorno: come stenderlo* è di default **Automatico**: il sito sceglie dal pezzo e scrive nel risultato cosa ha scelto e perché. Un guscio aperto (carena, cupola) con più del 3% di superficie quasi piatta — dove due strati piani finirebbero più distanti di un cordolo, lasciando i giri staccati — viene stampato ad *anelli che seguono la superficie*; un solido chiuso a *strati piani* (i suoi coperchi piatti non sono un contorno da seguire: per quelli c'è il riempimento); pareti sottili e reticoli sulla linea media. Con i supporti gli strati restano piani e il risultato lo dice. Si può sempre scegliere a mano: strati piani, spirale, anelli. *Verso dei giri* sceglie antiorario o orario.
- **Contorno a strati**: di default *contorno a strati* (un giro per strato; al cambio strato il cordolo non sale in verticale ma prosegue lungo il nuovo giro salendo gradualmente per *Rampa cambio strato* mm, 20 di default, come un unico filo; 0 = salto verticale come Tavolino1); tra contorni separati estrusore spento, sollevamento e riaccensione. Gli altri modi (spirale, pieno, superficie) si scelgono dal menu: vedi la tabella sotto. La spirale si usa solo se ogni strato è un unico contorno, altrimenti torna agli strati planari.
- **Collegamenti verificati**: un collegamento tra due tratti viene estruso solo se è corto (*Salto senza stop*, o fino a 8 cordoli tra passate vicine della serpentina) **e** resta sul materiale per tutta la lunghezza (dentro la sezione dello strato, o sulla superficie superiore nel modo superficie), con un margine di 1 mm al massimo. Tutti gli altri diventano spostamenti sollevati a estrusore spento. Le scelte euristiche (direzione delle passate, ordine) avvengono solo tra percorsi i cui collegamenti hanno passato questo controllo.
- **Curve che seguono la superficie** (opzione di *contorno a strati* e *spirale*): con strati piani tutto l'anello ha la stessa Z, quindi sulle superfici poco inclinate (cupole, carene) gli anelli si allontanano e su quelle ripide si schiacciano. Con l'opzione gli anelli non sono piani: **ogni punto** sta a un cordolo dall'anello precedente, misurato sulla superficie, e la distanza tiene conto della larghezza del cordolo: sulle pareti ripide un'altezza strato in Z, sulle zone piatte una larghezza cordolo di lato (cordoli affiancati, senza sovrapporsi), in mezzo Δz = min(altezza strato; larghezza cordolo · tan pendenza). Gli anelli salgono fino a chiudere tutta la superficie (anche i coperchi piani). A strati, un anello passa al successivo con un breve tratto stampato (cordolo continuo); a spirale è un unico percorso in cui ogni giro sale verso l'anello successivo punto per punto. Gli anelli girano sempre intorno al pezzo: finché le sezioni non sono giri completi (un bordo aperto non piano, un pezzo che tocca il piano in un punto) la parte bassa è stampata come nel contorno a strati, con la base del primo contorno pieno, e gli anelli partono dal primo giro completo. Il calcolo usa il fast marching sulla mesh, con i triangoli grandi suddivisi a mezzo cordolo.
- **Supporti**: *nessuno*, *nello stesso programma* (alternati strato per strato) o *in un file a parte* da stampare prima del pezzo. Per ogni strato si trova la parte che non appoggia sullo strato sotto (oltre l'angolo critico); quella zona scende fino al piano come una colonna. Di ogni colonna si stampa il contorno e, nelle zone larghe (la cima piatta di un guscio, il sotto di un cappello), un riempimento rado a zig-zag ogni 3 cordoli, fatto come un filo unico; le colonne vicine sono unite in un blocco. Sotto il pezzo resta uno strato di distacco, così il supporto si stacca bene. Con il file a parte si scaricano due programmi, `nome_SUP.src` (supporti, da lanciare prima) e `nome.src` (il pezzo, identico a quello senza supporti); simulazione e controllo collisioni li eseguono in sequenza come li esegue il robot (fine dei supporti → posizione sicura → homing → posizione sicura → primo punto del pezzo), con i supporti già stampati come ostacolo; la simulazione anima questi PTP negli assi. Il nome del programma dei supporti resta nei 24 caratteri del KRL: il nome del pezzo viene accorciato per lasciare spazio a `_SUP`. Il file a parte non è possibile con più pezzi o con le curve che seguono la superficie: in quel caso i supporti vanno nello stesso programma. Nella vista i supporti sono grigi.
- **Taglia la base** (solo per pezzi tuoi): il pezzo viene tagliato a questa altezza e appoggia sul taglio. Toglie materiale: il risultato avvisa che il pezzo stampato non è la mesh completa.
- **Pareti sottili e reticoli**: dove il pezzo è spesso al massimo *Pareti sottili → linea media* (10 mm di default) non si stampa il contorno, che darebbe due cordoli sovrapposti, ma **un solo cordolo sulla linea media**. Vale per un guscio cavo, per una parete sola e per un **reticolo** (nido d'ape, griglia, nervature): le pareti diventano un grafo di linee medie che si incontrano negli incroci, e il sito lo percorre con **un percorso unico per strato**, senza saltare da una cella all'altra. Un grafo si percorre in un solo tratto senza ripassare solo se al massimo due incroci hanno un numero dispari di pareti (Eulero); in un nido d'ape ogni incrocio ne ha tre, quindi qualche parete va ripassata: il sito sceglie l'insieme più corto di pareti da fare due volte e, di default, lì stende **due cordoli affiancati**, mezzo cordolo per parte rispetto alla linea media: l'estrusore non si ferma mai e nessun cordolo finisce sopra un altro (quella parete viene larga due cordoli, quindi più della mesh: è l'unico modo di fare un nido d'ape in un tratto solo, come fanno le stampanti 3D). In *Reticoli* si può scegliere invece di ripassare **a estrusore spento senza sollevarsi** (nessuna parete riceve doppio materiale, ma l'estrusore si spegne e si riaccende a ogni ripasso) o di ripassare stampando sopra il primo cordolo. Lo strato successivo riparte da dove è finito quello sotto, salendo in verticale. Le linee medie si trovano assottigliando la sezione su una griglia di 0,4 mm e poi centrando ogni punto esattamente tra le due facce della parete; se non coprono tutta la sezione, la sezione resta stampata com'era.
- **Pareti multiple**: offset verso l'interno con Clipper.

### Modi di stampa

| Modo | Cosa fa |
|---|---|
| Contorno · a strati piani | il contorno di ogni strato a Z costante, +altezza strato a ogni strato (come Tavolino1) |
| Contorno · a spirale | come sopra ma la Z sale lungo il giro (vase mode), senza giunzione |
| Contorno · anelli che seguono la superficie | anelli non piani, ogni punto a un cordolo dal precedente (vedi sopra) |
| Riempimento (pieno a serpentina) | il pezzo pieno con una serpentina continua (passata dopo passata, come un tosaerba), contorno esterno opzionale. Strati planari interi fino sotto il punto più basso della superficie superiore; poi, con *strati graduali*, N strati non planari che passano dal piano alla forma della superficie (strato k a quota taglio + (superficie − taglio)·k/N): ognuno copre tutta la sezione, cambia solo lo spessore (≈ ½–1½ altezza strato), l'ultimo è la superficie vera. Così non si formano isole e l'estrusore non si ferma (sella: 13 planari + 17 graduali, 0 stop). Direzione delle passate automatica (0/45/90/135°, meno interruzioni) |
| Superficie (superiore, a serpentina) | non planare: la serpentina segue la superficie superiore del pezzo (le facce più ripide di *pendenza max* sono fianchi e vengono escluse), mezzo cordolo dal bordo; più strati sovrapposti con *n° di strati*. Con *inclina utensile* il parametro C segue la pendenza nel piano Y-Z (C = 180° − arccos(Nz) per pendenze lungo Y, come nella calibrazione A −180 / B 0); la pendenza lungo X non è rappresentabile con il solo C e viene segnalata. Senza l'opzione l'utensile resta verticale. Il risultato indica la *copertura*: quota della superficie superiore effettivamente coperta dall'unione delle fasce depositate (griglia ≤ 2 mm), quindi i buchi locali la fanno scendere; è una misura su griglia, non una verifica continua di ogni punto |

## Posizione sul robot

Due modalità (sezione *Robot KUKA e piano*):

- **Centra sul punto indicato**: il centro del pezzo va in `X/Y` e la sua base alla *Quota pezzo Z in BASE* (default 38, cioè appoggiato sulla lastra); la prima passata è 0,5 mm sopra → Z 38,5 come Tavolino1. Il campo sposta il pezzo, non la lastra: la lastra e la sua griglia restano sempre a Z 38, quindi un pezzo messo più in basso si vede compenetrare il piano e l’esportazione è bloccata.
- **Mantieni posizione del file**: usa la posizione del pezzo nel file Rhino e sottrae l'origine della BASE in coordinate mondo (default 1448 / −1000 / 5, dal post-processore Python).

I dati del controller (`BASE_DATA[1]`, `TOOL_DATA[11]`, E1–E4 = 0) sono fissi e servono alla simulazione e al controllo di raggiungibilità. Il `.src` richiama `BASE_DATA[1]` e `TOOL_DATA[11]` del controller e, fuori dai movimenti `LIN`/`PTP`, è identico byte per byte a `Tavolino1.src`.

Tutti i parametri restano salvati nel browser.

## Sviluppo

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # test del motore (slicing, percorso, orientamento, writer KUKA)
npm run test:ui  # test dell'interfaccia in un browser vero (Playwright, Chromium)
npm run build    # sito statico in dist/
```

**Pezzo campione.** `tests/data/sella.stp` attraversa tutta la catena (import STEP, orientamento, percorso nei tre modi, controlli, `.src`) e il risultato viene confrontato con quello salvato in `tests/golden/`. Se una modifica cambia anche una sola riga del `.src` il test fallisce; quando il cambiamento è voluto, i riferimenti si rigenerano con:

```bash
npx vitest run -u
```

Test opzionale su un file Rhino reale:

```bash
GB_SAMPLE_3DM="/percorso/file.3dm" GB_SAMPLE_LAYER="Livello 04" GB_SAMPLE_INDEX=0 npx vitest run tests/real-file.test.ts
```

Ogni push su `main` esegue i test e pubblica il sito su GitHub Pages.

## Struttura

```
src/core/loaders.ts      import file → mesh (per layer/oggetto)
src/core/mesh.ts         mesh indicizzata, saldatura vertici, trasformazioni
src/core/slicer.ts       intersezione piano/mesh → contorni chiusi
src/core/walls.ts        pareti interne e linea media dei gusci (Clipper)
src/core/lattice.ts      reticoli a pareti sottili: linee medie e percorso unico
src/core/strategy.ts     scelta automatica di come stendere il contorno
src/core/edits.ts        modifiche a mano al percorso
src/core/orientation.ts  analisi orientamenti
src/core/toolpath.ts     percorso: contorno a strati, spirale, pieno, superficie
src/core/zigzag.ts       riempimento a serpentina e ordinamento delle passate
src/core/surface.ts      superficie superiore: proiezione, normali, parametro C
src/core/kuka.ts         writer KRL .src
src/core/pipeline.ts     orientamento → percorso → .src
src/worker.ts            calcolo in Web Worker
src/viewer.ts            anteprima 3D, clic su piano
src/core/robot.ts        frame KUKA, cinematica diretta/inversa KR16
scripts/build-cell.mjs   estrae robot, tavole e mandrino da BASE ROBOT.3dm
public/cell.*            cella fissa
src/main.ts              interfaccia
src/i18n.ts              traduzioni IT / EN
```
