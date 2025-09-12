console.log('[upgradable-items] | Loading...');
const upgradableAddCache = new Set();
let upgradableRenderCache = new Set();
let evaluationQueue = new Map();
const enhancementCallCache = new Set();
const itemGrantCache = new Set();
const itemRemovalCache = new Set();
const DAMAGE_DIE_MAP = { "1": "1d4", "2": "1d6", "3": "1d8" };
const CLUSTER_DAMAGE_TYPES = {
    "1": ["radiant", "thunder"],
    "2": ["acid", "necrotic"],
    "3": ["fire", "cold"]
};

const resistanceTypes = [
    "bludgeoning", "piercing", "slashing", // physical
    "fire", "cold", "lightning", "acid", "poison", // elemental
    "necrotic", "radiant", "psychic", "thunder", "force" // magical
];

// Utilities //
function getEquippedRuneArmor(actor) {
    return actor.items.find(i =>
        i.type === "equipment" &&
        i.system.equipped &&
        i.system.armor &&
        i.flags["upgradable-items"]
    );
}
function isRangedWeapon(item) {
    return item?.system?.actionType === "rwak";
}
function isMeleeWeapon(item) {
    return item?.system?.actionType === "mwak";
}

function isNaturalWeapon(item) {
    return item.type === "weapon" && item.system.weaponType === "natural";
}
function getDieFormula(level) {
    return { "1": "1d4", "2": "1d6", "3": "1d8" }[level] ?? "1d4";
}
function isRuneReady(actor, key) {
    return !actor.flags["upgradable-items"]?.[key];
}
async function rollEnhancementDie(formula) {
    const roll = new Roll(formula);
    await roll.evaluate({ async: true });
    return roll;
}
// Validate if equipped items meed requirements to add
function meetsUpgradableRequirements(item) {
    const attunementTypes = CONFIG.DND5E.attunementTypes;
    const isEquipped = item.system.equipped ?? false;
    const attunement = item.system.attunement ?? "";
    const isAttuned = item.system.attuned ?? false;
    const requiresAttunement = Object.entries(attunementTypes).some(([key]) => key === "required" && key === attunement);
    return isEquipped && (!requiresAttunement || isAttuned);
}

async function applySporewakeEffect(targetActor, template, damageDie = "1d4") {
    if (!targetActor || !template) return;

    // Prevent duplicate application if already poisoned by this template
    const existing = targetActor.effects.find(e =>
        e.label === "Poisoned (Sporewake)" &&
        e.origin === template.uuid
    );
    if (existing) return;

    // Roll saving throw first
    const save = await targetActor.rollAbilitySave("con", {
        flavor: "Sporewake Poison Cloud (DC 14)",
        dc: 14
    });

    if (save.total < 14) {
        // Roll poison damage
        const roll = await new Roll(damageDie).evaluate({ async: true });
        await targetActor.applyDamage(roll.total);

        // Apply poisoned condition starting next round
        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
            label: "Poisoned (Sporewake)",
            icon: "icons/magic/nature/plant-undersea-seaweed-glow-green.webp",
            origin: template.uuid,
            duration: {
                rounds: 1,
                startRound: (game.combat?.round ?? 0) + 1
            },
            description: `The target is poisoned by airborne fungal spores, suffering ${damageDie} damage for 1 round.`,
            flags: {
                core: { statusId: "Poisoned" },
                "upgradable-items": {
                    sourceTemplate: template.id,
                    damageDie
                }
            }
        }]);

        // Chat feedback
        ChatMessage.create({
            speaker: { actor: targetActor },
            content: `${targetActor.name} fails their save, takes ${roll.total} poison damage and is poisoned.`
        });
    } else {
        ChatMessage.create({
            speaker: { actor: targetActor },
            content: `${targetActor.name} succeeds their save and resists the Sporewake cloud.`
        });
    }
}

async function triggerSporewake(templateDoc, damageDie) {
    const template = canvas.templates.get(templateDoc.id);
    if (!template) return;

    const affectedTokens = canvas.tokens.placeables.filter(t =>
        t.actor?.type === "npc" &&
        t.document.disposition === -1 &&
        canvas.grid.measureDistance(template.center, t.center) <= template.document.distance
    );

    for (const token of affectedTokens) {
        await applySporewakeEffect(token.actor, template, damageDie);
    }
}

// Utility: Fetch compendium items by type (e.g. "spell", "feat")
async function getCompendiumItems(type) {
    const packs = game.packs.filter(p => p.documentName === "Item");
    const entries = [];

    for (const pack of packs) {
        const index = await pack.getIndex({ fields: ["name", "type", "system.identifier"] });

        for (const entry of index) {
            if (entry.type === type) {
                entries.push({
                    id: entry._id,
                    label: `${pack.metadata.label}: ${entry.name}`,
                    pack: pack.metadata.id,
                    name: entry.name,
                    identifier: entry.system?.identifier ?? null,
                    fullId: `${pack.metadata.id}.${entry._id}`
                });
            }
        }
    }

    return entries.sort((a, b) => a.label.localeCompare(b.label));
}

// Utility: Lookup compendiumEntires by identifier
async function findCompendiumItemByIdentifier(identifier) {
    const feats = await getCompendiumItems("feat");
    return feats.find(f => f.identifier === identifier) ?? null;
}

// Utility: Confirm compendium item exists, else create
async function getOrCreateFeat(featName, fallbackData) {
    const pack = game.packs.get("dnd5e.feats");
    const index = await pack.getIndex();
    const entry = index.find(e => e.name === featName);

    if (entry) {
        const feat = await pack.getDocument(entry._id);
        return feat.toObject();
    }

    // Fallback: manually create feat
    console.warn(`[Upgradable-Items] ${featName} not found in compendium. Creating fallback.`);
    return {
        name: featName,
        type: "feat",
        img: fallbackData.img,
        system: {
            description: { value: fallbackData.description },
            source: "Upgradable Module",
            activation: { type: "passive", cost: 0 },
            target: { value: null, type: "self" },
            duration: { value: null, units: "permanent" },
            actionType: "passive",
            requirements: "",
        },
        flags: {
            "upgradable-items": { injected: true }
        }
    };
}


// Utility : Pathfinding Functions
function getAdjacentTiles(token) {
    const gridSize = canvas.grid.size;
    const centerX = Math.round(token.center.x / gridSize) * gridSize;
    const centerY = Math.round(token.center.y / gridSize) * gridSize;

    const offsets = [
        [-gridSize, 0], [gridSize, 0], [0, -gridSize], [0, gridSize], // cardinal
        [-gridSize, -gridSize], [gridSize, -gridSize], [-gridSize, gridSize], [gridSize, gridSize] // diagonal
    ];

    return offsets.map(([dx, dy]) => {
        return {
            x: centerX + dx,
            y: centerY + dy
        };
    });
}


function isTileValid(pos, movingToken, maxDistance, excludeTokens = []) {
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return false;

    const tokenWidth = movingToken.document.width * canvas.grid.size;
    const tokenHeight = movingToken.document.height * canvas.grid.size;
    const proposedBounds = new PIXI.Rectangle(pos.x, pos.y, tokenWidth, tokenHeight);

    // Reject if overlapping with excluded tokens
    for (const t of excludeTokens) {
        const bounds = t.getBounds();
        if (proposedBounds.x < bounds.x + bounds.width &&
            proposedBounds.x + proposedBounds.width > bounds.x &&
            proposedBounds.y < bounds.y + bounds.height &&
            proposedBounds.y + proposedBounds.height > bounds.y) {
            return false;
        }
    }

    // Reject if overlapping with any other token
    const occupied = canvas.tokens.placeables.some(t => {
        if (t === movingToken || excludeTokens.includes(t)) return false;
        const bounds = t.getBounds();
        return proposedBounds.x < bounds.x + bounds.width &&
            proposedBounds.x + proposedBounds.width > bounds.x &&
            proposedBounds.y < bounds.y + bounds.height &&
            proposedBounds.y + proposedBounds.height > bounds.y;
    });
    if (occupied) return false;

    const distance = canvas.grid.measureDistance(movingToken.center, pos);
    if (distance > maxDistance + canvas.grid.size / 2) return false;

    try {
        return !movingToken.checkCollision(pos);
    } catch (err) {
        console.warn("Collision check failed:", err);
        return true;
    }
}

function findBestRushPosition(defenderToken, targetTokens) {
    const [allyToken, attackerToken] = targetTokens;
    const maxDistance = defenderToken.actor.system.attributes.movement.walk;
    const candidateTiles = [];

    for (const target of targetTokens) {
        const adj = getAdjacentTiles(target);
        candidateTiles.push(...adj);
    }

    candidateTiles.forEach(pos => {
        if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number" || !isFinite(pos.x) || !isFinite(pos.y)) {
            console.warn("[Guardian's Rush] Skipping invalid tile:", pos);
            return;
        }

        const isValid = isTileValid(pos, allyToken, maxDistance, targetTokens);
        canvas.scene.createEmbeddedDocuments("Drawing", [{
            type: "rectangle",
            x: pos.x,
            y: pos.y,
            width: canvas.grid.size,
            height: canvas.grid.size,
            strokeColor: isValid ? "#00ff00" : "#ff0000",
            strokeWidth: 3,
            fillAlpha: 0.2,
            flags: { "upgradable-items": { debugTile: true } }
        }]);
    });

    const validTiles = candidateTiles.filter(pos => {
        const adjacentToAlly = canvas.grid.measureDistance(pos, allyToken.center) <= canvas.grid.size + 1;
        const adjacentToAttacker = canvas.grid.measureDistance(pos, attackerToken.center) <= canvas.grid.size + 1;

        return adjacentToAlly &&
            adjacentToAttacker &&
            isTileValid(pos, defenderToken, maxDistance, [allyToken, attackerToken]);
    });

    if (validTiles.length === 0) {
        console.warn("[Guardian's Rush] No tile adjacent to both targets found. Trying fallback...");

        validTiles.push(...candidateTiles.filter(pos =>
            isTileValid(pos, defenderToken, maxDistance, [allyToken, attackerToken]) &&
            (
                canvas.grid.measureDistance(pos, allyToken.center) <= canvas.grid.size + 1 ||
                canvas.grid.measureDistance(pos, attackerToken.center) <= canvas.grid.size + 1
            )
        ));
    }

    // Sort by proximity to both targets
    validTiles.sort((a, b) => {
        const overlaps = (pos, token) => {
            const tokenBounds = token.getBounds();
            return pos.x >= tokenBounds.x && pos.x < tokenBounds.x + tokenBounds.width &&
                pos.y >= tokenBounds.y && pos.y < tokenBounds.y + tokenBounds.height;
        };

        const aOverlaps = overlaps(a, allyToken) || overlaps(a, attackerToken);
        const bOverlaps = overlaps(b, allyToken) || overlaps(b, attackerToken);

        if (aOverlaps && !bOverlaps) return 1;
        if (!aOverlaps && bOverlaps) return -1;

        const distA = canvas.grid.measureDistance(a, allyToken.center) + canvas.grid.measureDistance(a, attackerToken.center);
        const distB = canvas.grid.measureDistance(b, allyToken.center) + canvas.grid.measureDistance(b, attackerToken.center);
        return distA - distB;
    });

    //console.log("Candidate Tiles:", candidateTiles);
    //console.log("Valid Tiles:", validTiles);

    return validTiles[0]; // Best tile
}


// Utility : Rune Armor Effects logic
async function processRuneArmorEffects(attacker, target, item, context = {}) {
    const { isCritical, isSuccess, rolldata, itemdata } = context;

    const targetName = target?.name ?? "an unknown target";
    const armor = target ? getEquippedRuneArmor(target) : null;

    const cluster1 = armor?.getFlag("upgradable-items", "cluster1");
    const cluster2 = armor?.getFlag("upgradable-items", "cluster2");
    const cluster3 = armor?.getFlag("upgradable-items", "cluster3");
    const enhanceLvl = armor?.getFlag("upgradable-items", "enhanceLvl") ?? "1";
    const enhancementDie = getDieFormula(enhanceLvl);

    const isStandardAttack = ["mwak", "rwak"].includes(item.system.actionType);
    const isNaturalAttack = isNaturalWeapon(item);
    if (!isStandardAttack && !isNaturalAttack) {
        console.log("[Upgradable-Items] Skipping non-attack item:", item.name);
        return;
    }
    const hasActiveCluster = ["1", "2", "3"].includes(cluster1) || ["1", "2", "3"].includes(cluster2) || ["1", "2", "3"].includes(cluster3);

    // If the attack wasn't successful, narrate what would have happened
    if (!isSuccess && hasActiveCluster) {
        ChatMessage.create({
            speaker: { actor: target ?? attacker },
            content: `${attacker.name} missed ${targetName}. Rune armor effects were not triggered.`
        });
        return;
    }
    else {
        if (!isSuccess) {
            return;
        }
    }

    // Cluster III Tier 2: Bonus Action Block
    if (cluster2 === "3" && item.system.actionType === "mwak") {
        const flavor = `Rune Armor Pulse (DC 14)`;
        const attackerId = attacker.id;
        const flagKey = "cluster3Tier2Used";

        // Retrieve or initialize the attacker map
        const triggeredMap = target.getFlag("upgradable-items", flagKey) ?? {};

        // Check if this attacker has already triggered the effect
        if (!triggeredMap[attackerId]) {
            const save = await attacker.rollAbilitySave("con", { flavor, dc: 14 });

            // If failed, apply effect and mark attacker
            if (save.total < 14) {
                triggeredMap[attackerId] = true;
                await target.setFlag("upgradable-items", flagKey, triggeredMap);

                const effect = {
                    label: "Bonus Action Blocked",
                    icon: "icons/magic/control/debuff-energy-hold-teal-blue.webp",
                    origin: armor.uuid,
                    duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                    changes: [{
                        key: "system.actions.bonus",
                        mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
                        value: "0",
                        priority: 20
                    }],
                    flags: { "upgradable-items": { sourceItem: armor.id } }
                };
                await attacker.createEmbeddedDocuments("ActiveEffect", [effect]);
            }

            // Post result message
            ChatMessage.create({
                speaker: { actor: target ?? attacker },
                content: save.total < 14
                    ? `${attacker.name} fails the CON save and has their bonus action blocked by ${targetName}'s rune armor.`
                    : `${attacker.name} resists the pulse from ${targetName}'s rune armor.`
            });
        } else {
            console.log(`[Upgradable-Items] ${attacker.name} has already resolved the bonus action block check this combat.`);
        }
    }

    // Cluster I Tier 1: Retaliation
    if (cluster1 === "1" && item.system.actionType === "mwak") {
        const roll = await new Roll(enhancementDie).roll({ async: true });

        if (target && armor) {
            await attacker.applyDamage(roll.total);
        }

        ChatMessage.create({
            speaker: { actor: target ?? attacker },
            content: `${attacker.name} is shocked by ${targetName}'s rune armor for ${roll.total} lightning damage!`
        });
    }

    // Cluster I Tier 3: AC to Allies
    if (cluster3 === "1" && item.system.actionType === "mwak") {
        const originToken = target?.getActiveTokens?.()[0];
        const nearbyAllies = originToken
            ? canvas.tokens.placeables.filter(t =>
                t.actor?.id !== target.id &&
                t.actor?.type === "character" &&
                canvas.grid.measureDistance(originToken, t) <= 10)
            : [];

        if (target && armor && nearbyAllies.length > 0) {
            for (const allyToken of nearbyAllies) {
                const allyActor = allyToken.actor;
                const existing = allyActor.effects.find(e =>
                    e.label === "Rune Shield" && e.origin === armor.uuid);
                if (existing) await allyActor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);

                const effect = {
                    label: "Rune Shield",
                    icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
                    origin: armor.uuid,
                    duration: { rounds: 2, startRound: game.combat?.round ?? 0 },
                    description: "Gain +2 AC for 2 rounds from the rune armor.",
                    changes: [{
                        key: "system.attributes.ac.bonus",
                        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                        value: "2",
                        priority: 20
                    }],
                    flags: { "upgradable-items": { sourceItem: armor.id } }
                };
                await allyActor.createEmbeddedDocuments("ActiveEffect", [effect]);
            }
        }

        ChatMessage.create({
            speaker: { actor: target ?? attacker },
            content: target
                ? `Allies within 10 ft of ${target.name} gain +2 AC for 2 rounds from the rune armor.`
                : `Rune armor would grant +2 AC to nearby allies if a target were selected.`
        });
    }
}

// Logic Functions //
// Logic Functions - Check item and enhancements to be added for eqipping/attuning
async function evaluateUpgradableItem(item) {
    const actor = item.actor;
    if (!actor || !item.flags?.["upgradable-items"]) return;

    const cluster1 = await item.getFlag("upgradable-items", "cluster1") ?? "0";
    const cluster2 = await item.getFlag("upgradable-items", "cluster2") ?? "0";
    const cluster3 = await item.getFlag("upgradable-items", "cluster3") ?? "0";
    const enhanceLvl = await item.getFlag("upgradable-items", "enhanceLvl") ?? "0";
    const enhancementDie = await getDieFormula(enhanceLvl);

    const itemId = item.id;
    if (evaluationQueue.has(itemId)) return; // debounce
    evaluationQueue.set(itemId, true);
    setTimeout(() => evaluationQueue.delete(itemId), 100); // release after 100ms

    const meetsRequirements = meetsUpgradableRequirements(item);

    const enhanceLvlKey = item.getFlag("upgradable-items", "enhanceLvl") ?? "0";
    const bonus = parseInt(enhanceLvlKey, 10);
    const effectLabel = `${item.name} Enhancement +${bonus} AC`;

    // Armor Logic
    const isArmor = item.type === "equipment" && item.system.armor?.type !== "natural";
    if (isArmor) {
        const existingEffects = actor.effects.filter(e =>
            e.origin === item.uuid &&
            e.changes?.some(c => c.key === "system.attributes.ac.bonus")
        );

        const expectedBonus = bonus > 0 ? bonus : null;
        const existingBonus = existingEffects[0]?.changes?.find(c => c.key === "system.attributes.ac.bonus")?.value ?? null;

        const hasCorrectEffect = expectedBonus && parseInt(existingBonus) === expectedBonus;
        const shouldHaveEffect = meetsRequirements && expectedBonus;

        // Remove if effect exists but shouldn't, or is incorrect
        if (existingEffects.length > 0 && (!shouldHaveEffect || !hasCorrectEffect)) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", existingEffects.map(e => e.id));
            console.log(`[Upgradable-Items] Removed ${existingEffects.length} enhancement effects from ${item.name}`);
        }

        // Add if effect is missing and should exist
        if (shouldHaveEffect && !hasCorrectEffect) {
            const effectData = {
                label: effectLabel,
                icon: item.img,
                origin: item.uuid,
                disabled: false,
                changes: [{
                    key: "system.attributes.ac.bonus",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: expectedBonus,
                    priority: 20
                }],
                flags: {
                    core: { statusId: effectLabel },
                    "upgradable-items": { sourceItem: item.id }
                }
            };
            await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
            console.log(`[Upgradable-Items] Applied enhancement effect: ${effectLabel}`);
        }
    }

    // Spell/Feat Logic
    const selectedSpell = item.getFlag("upgradable-items", "selectedSpell");
    const selectedFeat = item.getFlag("upgradable-items", "selectedFeat");

    const findGrantedItem = (entryId) => actor.items.find(i =>
        i.flags?.["upgradable-items"]?.sourceId === item.id &&
        i.flags?.["upgradable-items"]?.entryId === entryId
    );

    if (meetsRequirements) {
        if (selectedSpell && !findGrantedItem(selectedSpell)) {
            await addItemToActor(actor, selectedSpell, item);
        }
        if (selectedFeat && !findGrantedItem(selectedFeat)) {
            await addItemToActor(actor, selectedFeat, item);
        }
    } else {
        if (selectedSpell) {
            const spellItem = findGrantedItem(selectedSpell);
            if (spellItem) await actor.deleteEmbeddedDocuments("Item", [spellItem.id]);
        }
        if (selectedFeat) {
            const featItem = findGrantedItem(selectedFeat);
            if (featItem) await actor.deleteEmbeddedDocuments("Item", [featItem.id]);
        }
    }
    // Cluster I Tier 2 Armor: Grant Passive ability to move through allies without provoking opportunity attacks
    //if (item.type === "equipment" && cluster2 === "1") {
    //    const meetsRequirements = meetsUpgradableRequirements(item);
    //    const actor = item.actor;

    //    const effectLabel = "Rune Evasion";
    //    const existing = actor.effects.find(e =>
    //        e.label === effectLabel &&
    //        e.origin === item.uuid
    //    );

    //    if (meetsRequirements && !existing) {
    //        const evasionEffect = {
    //            label: effectLabel,
    //            icon: "icons/magic/movement/trail-streak-impact-blue.webp",
    //            origin: item.uuid,
    //            duration: { seconds: 3600 }, // optional: 1 hour placeholder
    //            changes: [],
    //            description: "You can move through allies without provoking opportunity attacks once per short rest.",
    //            flags: {
    //                "upgradable-items": { sourceItem: item.id }
    //            }
    //        };
    //        await actor.createEmbeddedDocuments("ActiveEffect", [evasionEffect]);
    //    } else if (!meetsRequirements && existing) {
    //        await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
    //    }
    //}
    if (item.type === "equipment" && cluster2 === "1") {
        const cluster2 = item.getFlag("upgradable-items", "cluster2");
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;
        const itemName = item.name;
        const effectLabel = `Rune Evasion (${itemName})`;
        const effectKey = "cluster2Tier1Effect";

        // Remove existing Rune Evasion effect first
        const existing = actor.effects.find(e =>
            e.label?.startsWith("Rune Evasion") &&
            e.origin === item.uuid &&
            e.flags?.["upgradable-items"]?.sourceItem === item.id &&
            e.flags?.["upgradable-items"]?.effectKey === effectKey
        );

        if (existing) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
            console.log(`[Upgradable-Items] Removed existing Rune Evasion effect for ${itemName}`);
        }

        // Reapply if cluster2 is "1" and requirements are met
        if (cluster2 === "1" && meetsRequirements) {
            const evasionEffect = {
                label: effectLabel,
                icon: "icons/magic/movement/trail-streak-impact-blue.webp",
                origin: item.uuid,
                duration: { seconds: 3600 }, // Optional: 1 hour placeholder
                changes: [],
                description: "You can move through allies without provoking opportunity attacks once per short rest.",
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        effectKey
                    }
                }
            };

            await actor.createEmbeddedDocuments("ActiveEffect", [evasionEffect]);
            console.log(`[Upgradable-Items] Applied Rune Evasion effect for ${itemName}`);
        }
    }

    // Cluster II Tier 2 : Armor : Grant Mobile feat
    if (item.type === "equipment" && cluster2 === "2") {
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;
        const itemName = item.name;
        const entryId = "mobile";

        const findGrantedItem = () => actor.items.find(i =>
            i.flags?.["upgradable-items"]?.sourceId === item.id &&
            i.flags?.["upgradable-items"]?.entryId === entryId
        );

        // Always remove existing Mobile feat first
        const existing = findGrantedItem();
        if (existing) {
            await actor.deleteEmbeddedDocuments("Item", [existing.id]);
            console.log(`[Upgradable-Items] Removed existing Mobile feat for ${itemName}`);
        }

        // Only re-add if cluster2 === "2" and requirements are met
        if (cluster2 === "2" && meetsRequirements) {
            const mobileEntry = await findCompendiumItemByIdentifier(entryId);

            const mobilityEffect = {
                label: "Mobility Speed Boost",
                icon: "icons/skills/movement/feet-winged-boots-blue.webp",
                origin: item.uuid,
                changes: [{
                    key: "system.attributes.movement.walk",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: "10",
                    priority: 20
                }],
                disabled: false,
                duration: { startRound: null, rounds: null },
                flags: {
                    "upgradable-items": { sourceItem: item.id }
                }
            };

            let mobilityFeat;

            if (!mobileEntry) {
                console.warn("[Upgradable-Items] Mobile feat not found by identifier. Creating fallback.");

                mobilityFeat = {
                    name: `Mobile (${itemName})`,
                    type: "feat",
                    img: "icons/skills/movement/feet-winged-boots-blue.webp",
                    system: {
                        description: {
                            value: "Your speed increases by 10ft. You ignore difficult terrain when you Dash, and when you make a melee attack against a creature, you don't provoke opportunity attacks from that creature for the rest of the turn."
                        },
                        source: "Upgradable Module",
                        activation: { type: "passive", cost: 0 },
                        target: { value: null, type: "self" },
                        duration: { value: null, units: "permanent" },
                        actionType: "passive",
                        requirements: ""
                    },
                    flags: {
                        "upgradable-items": {
                            injected: true,
                            sourceId: item.id,
                            entryId
                        }
                    },
                    effects: [mobilityEffect]
                };
            } else {
                mobilityFeat = await mobileEntry.document.toObject();
                mobilityFeat.name = `Mobile (${itemName})`;
                mobilityFeat.flags = mobilityFeat.flags ?? {};
                mobilityFeat.flags["upgradable-items"] = {
                    injected: true,
                    sourceId: item.id,
                    entryId
                };
                mobilityFeat.effects = mobilityFeat.effects ?? [];
                mobilityFeat.effects.push(mobilityEffect);
            }

            await actor.createEmbeddedDocuments("Item", [mobilityFeat]);
            console.log(`[Upgradable-Items] Added Mobile feat (${itemName})`);
        }
    }

    // Cluster III Tier 3: Ranged Weapon : Gain Sharpshooter Feat allowing ignore of cover to target. 
    if (item.type === "weapon" && isRangedWeapon(item) && cluster3 === "3") {
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;
        const itemName = item.name;
        const entryId = "sharpshooter";

        const findGrantedItem = () => actor.items.find(i =>
            i.flags?.["upgradable-items"]?.sourceId === item.id &&
            i.flags?.["upgradable-items"]?.entryId === entryId
        );

        // Always remove existing Sharpshooter feat first
        const existing = findGrantedItem();
        if (existing) {
            await actor.deleteEmbeddedDocuments("Item", [existing.id]);
            console.log(`[Upgradable-Items] Removed existing Sharpshooter feat for ${itemName}`);
        }

        // Only re-add if cluster3 === "3" and requirements are met
        if (cluster3 === "3" && meetsRequirements) {
            const sharpshooterEntry = await findCompendiumItemByIdentifier(entryId);

            let sharpshooterFeat;

            if (!sharpshooterEntry) {
                console.warn("[Upgradable-Items] Sharpshooter feat not found by identifier. Creating fallback.");

                sharpshooterFeat = {
                    name: `Sharpshooter (${itemName})`,
                    type: "feat",
                    img: "icons/skills/ranged/target-bullseye-archer-orange.webp",
                    system: {
                        description: {
                            value: "Being within 5 feet of an enemy doesn't impose Disadvantage on your attack rolls with Ranged weapons and ignore half and three-quarters cover"
                        },
                        source: "Upgradable Module",
                        activation: { type: "passive", cost: 0 },
                        target: { value: null, type: "self" },
                        duration: { value: null, units: "permanent" },
                        actionType: "passive",
                        requirements: ""
                    },
                    flags: {
                        "upgradable-items": {
                            injected: true,
                            sourceId: item.id,
                            entryId
                        }
                    }
                };
            } else {
                sharpshooterFeat = await sharpshooterEntry.document.toObject();
                sharpshooterFeat.name = `Sharpshooter (${itemName})`;
                sharpshooterFeat.flags = sharpshooterFeat.flags ?? {};
                sharpshooterFeat.flags["upgradable-items"] = {
                    injected: true,
                    sourceId: item.id,
                    entryId
                };
            }

            await actor.createEmbeddedDocuments("Item", [sharpshooterFeat]);
            console.log(`[Upgradable-Items] Added Sharpshooter feat (${itemName})`);
        }
    }
}

// Logic Functions - Enhancement and Cluster 1 Damage implementation
async function applyUpgradableEnhancement(item) {
    const actor = item.actor;
    if (!actor || item.type !== "weapon") return;

    const cacheKey = `${actor.id}::${item.id}::enhancement`;
    if (enhancementCallCache.has(cacheKey)) return;
    enhancementCallCache.add(cacheKey);
    setTimeout(() => enhancementCallCache.delete(cacheKey), 300);

    const flags = item.flags["upgradable-items"] ?? {};
    const { enhanceLvl = "0", cluster1 = "0", cluster2 = "0", cluster3 = "0" } = flags;

    const meetsRequirements = meetsUpgradableRequirements(item);

    const damageDie = DAMAGE_DIE_MAP[enhanceLvl] ?? "1d4";
    const damageTypes = CLUSTER_DAMAGE_TYPES[cluster1] ?? [];
    const damageType = damageTypes.length > 0
        ? damageTypes[Math.floor(Math.random() * damageTypes.length)]
        : null;

    const enhancementDie = damageDie && damageType ? damageDie : null;

    // Retrieve previously injected type
    const previousType = item.getFlag("upgradable-items", "injectedDamageType");

    const updates = {};
    const updateSection = (section) => {
        const bonus = item.system.damage?.[section]?.bonus ?? "";
        const types = Array.from(item.system.damage?.[section]?.types ?? []);

        let newBonus = bonus;
        if (enhanceLvl === "0" || !meetsRequirements || !enhancementDie) {
            newBonus = bonus.replace(/(1d4|1d6|1d8)/g, "").trim();
        } else {
            newBonus = enhancementDie;
        }

        // Remove previously injected type only
        const filteredTypes = types.filter(t => t !== previousType);
        const newTypes = meetsRequirements && damageType ? [...filteredTypes, damageType] : filteredTypes;

        updates[`system.damage.${section}.bonus`] = newBonus;
        updates[`system.damage.${section}.types`] = newTypes;

        return {
            currentBonus: bonus,
            currentTypes: types,
            newBonus,
            newTypes
        };
    };

    if (isMeleeWeapon(item) || isRangedWeapon(item)) {
        const base = updateSection("base");
        const versatile = item.system.damage?.versatile ? updateSection("versatile") : null;

        // Cluster I Ranged Weapon: Inject Sonic damage type
        if (isRangedWeapon(item) && meetsRequirements && cluster1 === "1") {
            const sonicType = "sonic";

            const injectSonic = (section) => {
                const types = Array.from(item.system.damage?.[section]?.types ?? []);
                if (!types.includes(sonicType)) {
                    updates[`system.damage.${section}.types`] = [...types, sonicType];
                }
            };

            injectSonic("base");
            if (item.system.damage?.versatile) injectSonic("versatile");
        }

        const changed =
            base.currentBonus !== base.newBonus ||
            JSON.stringify(base.currentTypes) !== JSON.stringify(base.newTypes) ||
            (versatile &&
                (versatile.currentBonus !== versatile.newBonus ||
                    JSON.stringify(versatile.currentTypes) !== JSON.stringify(versatile.newTypes)));

        if (changed) {
            await item.update(updates);
            await item.setFlag("upgradable-items", "injectedDamageType", damageType); // Track new type
            console.log(`[Upgradable-Items] Enhancement updated for ${item.name}`, updates);
        }
    }
}

// Logic Functions - Range Weapon Enhancements
async function applyRangedEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster = upgrades.cluster1;
    if (level == 0) return;

    const damageDie = DAMAGE_DIE_MAP[level] ?? "1d4";
    const damageType = CLUSTER_DAMAGE_TYPES[cluster] ?? [];


    const roll = new Roll(`${damageDie}`);
    await roll.evaluate({ async: true });
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes a ${damageType} burst from its enhancement!`,
        rollMode: game.settings.get("core", "rollMode")
    });
}

// Logic Functions - Melee Weapon Enhancements
async function applyMeleeEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster1 = upgrades.cluster1;
    const cluster2 = upgrades.cluster2;
    const cluster3 = upgrades.cluster3;
    if (level === "0") return;

    const damageDie = DAMAGE_DIE_MAP[level] ?? "1d4";

    // Tier 1: Elemental Damage
    const damageTypes = CLUSTER_DAMAGE_TYPES[cluster1] ?? [];
    const damageType = damageTypes[Math.floor(Math.random() * damageTypes.length)] ?? "force";

    /*const roll = new Roll(damageDie);*/
    const roll = new Roll(`${damageDie}`);
    await roll.evaluate({ async: true });

    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes ${roll.total} ${damageType} damage from its Cluster I rune.`,
        rollMode: game.settings.get("core", "rollMode"),
        flags: {
            "upgradable-items": {
                clusterTier: "tier1",
                enhancementDie: damageDie,
                damageType: damageType
            }
        }
    });

    // Store cluster2 and cluster3 for later crit/hit hooks
    await actor.setFlag("upgradable-items", "meleeCluster2", cluster2);
    await actor.setFlag("upgradable-items", "meleeCluster3", cluster3);
    await actor.setFlag("upgradable-items", "meleeClusterItemId", item.id);
}

// Logic Functions - Add item to actor from compendium for Spell/Feat Options
async function addItemToActor(actor, compRef, sourceItem) {
    const [packId, entryId] = compRef.split(/(?<=\..+)\.(?=[^\.]+$)/);
    const pack = game.packs.get(packId);
    if (!pack) {
        console.warn(`[Upgradable-Items] Pack not found: ${packId}`);
        return;
    }

    console.log(`[Upgradable-Items] Fetching entryId: ${entryId} from pack: ${packId}`);
    const entry = await pack.getDocument(entryId);
    if (!entry) {
        console.warn(`[Upgradable-Items] Entry not found in pack: ${entryId}`);
        return;
    }

    // Debounce logic
    const cacheKey = `${actor.id}::${sourceItem.id}::${entry.id}`;
    if (upgradableAddCache.has(cacheKey)) {
        console.log(`[Upgradable-Items] Skipping cached add for ${entry.name}`);
        return;
    }
    upgradableAddCache.add(cacheKey);
    setTimeout(() => upgradableAddCache.delete(cacheKey), 500);

    // Check for existing item
    const alreadyExists = actor.items.find(i =>
        i.flags?.["upgradable-items"]?.sourceId === sourceItem.id &&
        i.flags?.["upgradable-items"]?.entryId === entry.id
    );

    if (alreadyExists) {
        //console.log(`[Upgradable-Items] Skipping duplicate: ${entry.name}`);
        return;
    }

    // Clone and tag the item
    const clone = entry.toObject();
    clone.flags = clone.flags || {};
    clone.flags["upgradable-items"] = {
        sourceId: sourceItem.id,
        entryId: entry.id
    };

    // Append source item name to granted item name
    clone.name = `${clone.name} (${sourceItem.name})`;

    // Optional: tag description
    if (clone.system?.description?.value !== undefined) {
        clone.system.description.value += `<p><em>Granted by ${sourceItem.name}</em></p>`;
    }

    // Apply attunement/equipped if required
    if (sourceItem.flags?.["upgradable-items"]?.requiresAttunement) {
        clone.system.attunement = CONFIG.DND5E.attunementTypes.REQUIRED;
    }

    if (sourceItem.flags?.["upgradable-items"]?.requiresEquipped) {
        clone.system.equipped = true;
    }

    await actor.createEmbeddedDocuments("Item", [clone]);
    console.log(`[Upgradable-Items] Added item: ${clone.name} to ${actor.name}`);
}

// Logic Functions - Remove item from actor added by Spell/Feat Options
async function removeItemFromActor(actor, compRef, sourceItem) {
    if (!actor || !compRef || !sourceItem) return;

    const parts = compRef.split(".");
    const entryId = parts.at(-1);

    if (!entryId || typeof entryId !== "string") {
        console.warn(`[Upgradable-Items] Invalid entryId for removal: ${compRef}`);
        return;
    }

    const cacheKey = `${actor.id}::${sourceItem.id}::${entryId}`;
    if (itemRemovalCache.has(cacheKey)) return;
    itemRemovalCache.add(cacheKey);
    setTimeout(() => itemRemovalCache.delete(cacheKey), 300);


    const toRemove = actor.items.filter(i =>
        i.flags?.["upgradable-items"]?.sourceId === sourceItem.id &&
        i.flags?.["upgradable-items"]?.entryId === entryId
    );

    if (!toRemove.length) {
        console.warn(`[Upgradable-Items] No matching item found for removal: ${entryId}`);
        return;
    }

    // Validate that each item still exists before deletion
    const validIds = toRemove.map(i => i.id).filter(id => actor.items.get(id));
    if (!validIds.length) {
        console.warn(`[Upgradable-Items] No valid item IDs found for deletion: ${entryId}`);
        return;
    }

    try {
        await actor.deleteEmbeddedDocuments("Item", validIds);
        console.log(`[Upgradable-Items] Removed item(s): ${validIds.join(", ")}`);
    } catch (err) {
        console.warn(`[Upgradable-Items] Failed to remove item(s): ${validIds.join(", ")}`, err);
    }
}

// Runic Empowerment (Stat boosts) Logic
async function updateRunicEmpowermentEffect(item) {
    const actor = item.actor;
    if (!actor) return;

    const label = `Runic Empowerment (${item.name})`;
    const existing = actor.effects.find(e => e.label === label && e.origin === item.uuid);
    const meetsRequirements = meetsUpgradableRequirements(item);
    console.warn(meetsRequirements);

    // If item no longer qualifies, remove the effect
    if (!meetsRequirements) {
        if (existing) await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
        return;
    }

    const abilities = ["str", "dex", "con", "int", "wis", "cha"];
    const boosts = abilities.map(ab => ({
        ability: ab,
        value: parseInt(item.getFlag("upgradable-items", `empowerment-${ab}`) ?? "0")
    })).filter(b => b.value > 0);

    // If no boosts are defined, remove any existing effect and exit
    if (boosts.length === 0) {
        if (existing) await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
        return;
    }

    // Remove existing effect before reapplying
    if (existing) await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);

    // Determine icon based on item type
    let icon = item.img;
    if (item.type === "weapon" && item.system.actionType === "mwak") {
        icon = "icons/weapons/swords/sword-flanged-lightning.webp";
    } else if (item.type === "weapon" && item.system.actionType === "rwak") {
        icon = "icons/weapons/ammunition/arrowhead-glowing-blue.webp";
    } else if (item.type === "equipment" && item.system.armor) {
        icon = "icons/magic/defensive/shield-barrier-blue.webp";
    }

    const changes = boosts.map(b => ({
        key: `system.abilities.${b.ability}.value`,
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: `${b.value}`,
        priority: 20
    }));

    const description = boosts.map(b => `${b.ability.toUpperCase()}: +${b.value}`).join(", ");

    const effectData = {
        label,
        icon,
        origin: item.uuid,
        duration: { rounds: 9999 },
        description: `Runic Empowerment grants: ${description}`,
        changes,
        flags: {
            "upgradable-items": { sourceItem: item.id }
        }
    };

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

// Hooks //
Hooks.once("init", () => {
    loadTemplates(["modules/upgradable-items/templates/upitab-template.hbs"]);
    Handlebars.registerHelper("ifEquals", function (a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
    });
    Handlebars.registerHelper("range", (start, end) => {
        return Array.from({ length: end - start + 1 }, (_, i) => i + start);
    });
});

Hooks.on("dnd5e.rollAttack", async (itemdata, rolldata) => {
    const activity = rolldata;

    const attacker = itemdata.actor ?? null;
    const item = itemdata ?? null;

    if (!attacker || !item) {
        console.warn("[Upgradable-Items] Missing attacker or item — possibly unresolved getters");
        setTimeout(() => {
            const attacker = itemdata.actor;
            const item = itemdata;
            console.log("[Upgradable-Items] Delayed access:", attacker, item);
        }, 0);
    }

    const userTargets = Array.from(game.user?.targets ?? []);
    if (userTargets.length === 0) return;

    const isCrit = rolldata?.isCritical ?? false;
    const isSuccess = rolldata?.isSuccess ?? false;

    if (!isSuccess) {
        console.log("[Upgradable-Items] Attack did not succeed");
        return;
    }

    for (const targetToken of userTargets) {
        const targetActor = targetToken.actor;
        if (!targetActor) continue;

        if (isSuccess) {
            console.log(`[Upgradable-Items] Confirmed hit: ${attacker.name} - ${targetActor.name} with ${item.name}`);
        }
        else {
            console.log(`[Upgradable-Items] Failed to hit: ${attacker.name} - ${targetActor.name} with ${item.name}`);
        }
        await processRuneArmorEffects(attacker, targetActor, item, {
            isCritical: isCrit,
            isSuccess: isSuccess,
            rolldata: rolldata,
            itemdata: itemdata
        });
    }

    // Cluster II Tier 3 : Armor : Guardian's Rush — Reaction
    if (game.combat) {
        const isSuccess = rolldata?.isSuccess ?? false;
        if (!isSuccess) return;

        const attacker = itemdata.actor;
        const targets = Array.from(game.user?.targets ?? []);
        if (targets.length === 0) return;

        const allyToken = targets[0];
        const allyActor = allyToken.actor;
        if (!allyActor) return;
        // Find eligible defenders
        const defenders = [];

        for (const combatant of game.combat.combatants) {
            const actor = combatant.actor;
            if (!actor || actor.id === allyActor.id) continue;
            const armor = getEquippedRuneArmor(actor);
            if (!armor) continue;

            const cluster3 = armor.getFlag("upgradable-items", "cluster3");
            const used = actor.getFlag("upgradable-items", "guardianRushUsed");
            const meets = meetsUpgradableRequirements(armor);

            if (cluster3 === "2" && !used && meets) {
                const token = actor.getActiveTokens()[0];
                if (token) defenders.push(token);
            }
        }

        if (defenders.length === 0) {
            console.log("[Upgradable-Items] Guardian's Rush - No eligible defenders found.");
        }


        for (const defenderToken of defenders) {
            const defenderActor = defenderToken.actor;
            const distance = canvas.grid.measureDistance(defenderToken, allyToken);
            if (distance > defenderActor.system.attributes.movement.walk) continue;

            const confirmed = await new Promise(resolve => {
                new Dialog({
                    title: "Guardian's Rush",
                    content: `<p>${defenderActor.name}, would you like to use Guardian's Rush to protect ${allyActor.name}?</p>`,
                    buttons: {
                        yes: {
                            label: "Yes",
                            callback: () => resolve(true)
                        },
                        no: {
                            label: "No",
                            callback: () => resolve(false)
                        }
                    },
                    default: "no"
                }).render(true);
            });

            if (!confirmed) continue;

            // Move defender adjacent to ally — with input guards
            const center = allyToken?.center;
            if (!center || typeof center.x !== "number" || typeof center.y !== "number") {
                console.warn(`[Upgradable-Items] - Guardian's Rush Invalid ally token center:`, center);
                continue; // Skip this defender if center is invalid
            }
            const attackerToken = attacker.getActiveTokens()[0];
            if (!attackerToken) return;


            const bestPosition = findBestRushPosition(defenderToken, [allyToken, attackerToken]);

            if (!bestPosition || typeof bestPosition.x !== "number" || typeof bestPosition.y !== "number") {
                console.warn("[Guardian's Rush] No valid position returned from pathfinding.");
                ui.notifications.warn(`${defenderActor.name} could not find a reachable adjacent space.`);
                continue;
            }

            console.log(`[Guardian's Rush] Moving ${defenderToken.name} to (${Math.round(bestPosition.x)}, ${Math.round(bestPosition.y)})`);

            await defenderToken.document.update({
                x: Math.round(bestPosition.x),
                y: Math.round(bestPosition.y)
            });
            //await defenderActor.setFlag("upgradable-items", "guardianRushUsed", true);

            // Remove any existing Guardian's Rush Disadvantage effect
            const existingEffects = attacker.effects.filter(e =>
                e.flags?.["upgradable-items"]?.effectKey === "guardianRushDisadvantage"
            );

            for (const effect of existingEffects) {
                await attacker.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
            }
            const effect = {
                label: "Guardian's Rush Disadvantage",
                icon: "icons/magic/air/air-pressure-shield-blue.webp",
                origin: defenderToken.actor.uuid,
                duration: { rounds: 1, startRound: game.combat.round },
                changes: [{
                    key: "system.bonuses.attack.disadvantage",
                    mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
                    value: "true",
                    priority: 20
                }],
                description: "This creature suffers disadvantage on all attack rolls until the end of the round, having been disrupted by a guardian's sudden interposition.",
                flags: {
                    "upgradable-items": {
                        sourceItem: getEquippedRuneArmor(defenderActor)?.id,
                        effectKey: "guardianRushDisadvantage"
                    }
                }
            };

            await attacker.createEmbeddedDocuments("ActiveEffect", [effect]);

            ChatMessage.create({
                speaker: { actor: defenderActor },
                content: `${defenderActor.name} blurs across the battlefield, interposing themselves to protect ${allyActor.name}. <strong>${attacker.name}</strong> suffers <em>disadvantage on all attack rolls</em> until the end of the round.`
            });
        }
    }
});

Hooks.on("preUpdateItem", async (item, changes) => {
    if (!["equipment", "weapon", "tool"].includes(item.type)) return;
    const actor = item.actor;
    if (!actor) return;

    const itemFlags = foundry.utils.getProperty(item.flags, "upgradable-items") ?? {};
    const attunementTypes = CONFIG.DND5E.attunementTypes;
    const wasEquipped = item.system.equipped;
    const willBeEquipped = changes.system?.equipped;
    const attunement = item.system.attunement ?? "";
    const attunementRequired = Object.entries(attunementTypes).some(([key]) => key === "required" && key === attunement);
    const wasAttuned = item.system.attuned;
    const willBeAttuned = changes.system?.attuned;

    const unequipped = wasEquipped && willBeEquipped === false;
    const unattuned = attunementRequired && wasAttuned && willBeAttuned === false;

    const oldCluster2 = item.getFlag("upgradable-items", "cluster2");
    const newCluster2 = changes.flags?.["upgradable-items"]?.cluster2;
    const cluster2Changed = oldCluster2 && oldCluster2 !== newCluster2;

    const oldCluster3 = item.getFlag("upgradable-items", "cluster3");
    const newCluster3 = changes.flags?.["upgradable-items"]?.cluster3;
    const cluster3Changed = oldCluster3 && oldCluster3 !== newCluster3;

    const deletedIds = actor.getFlag("upgradable-items", "deletedItemIds") ?? [];

    // Helper to safely delete and track
    async function safeDelete(itemId, label) {
        if (!deletedIds.includes(itemId) && actor.items.has(itemId)) {
            try {
                await actor.deleteEmbeddedDocuments("Item", [itemId]);
                deletedIds.push(itemId);
                await actor.setFlag("upgradable-items", "deletedItemIds", deletedIds);
                console.log(` Deleted ${label}: ${itemId}`);
            } catch (err) {
                console.warn(`[Upgradable-Items] Failed to delete ${label}: ${itemId}`, err);
            }
        } else {
            console.log(`[Upgradable-Items] Skipped ${label}: ${itemId} already deleted or missing`);
        }
    }

    // Remove Mobile if cluster2 changed
    if (cluster2Changed && item.type === "equipment") {
        if (newCluster2 !== "2") {
            const mobileEntry = await findCompendiumItemByIdentifier("mobile");

            if (mobileEntry) {
                await safeDelete(mobileEntry.id, "Mobile (compendium)");
            } else {
                const fallbackMobile = actor.items.find(i =>
                    i.flags?.["upgradable-items"]?.entryId === "mobile" &&
                    i.flags?.["upgradable-items"]?.sourceId === item.id
                );
                if (fallbackMobile) {
                    await safeDelete(fallbackMobile.id, "Mobile (fallback)");
                }
            }
        }

        if (newCluster2 !== "1") {
            // Remove only the Rune Evasion effect tied to this item
            const runeEvasionEffect = actor.effects.find(e =>
                e.origin === item.uuid &&
                e.flags?.["upgradable-items"]?.sourceItem === item.id &&
                e.flags?.["upgradable-items"]?.effectKey === "cluster2Tier1Effect"
            );

            if (runeEvasionEffect) {
                await actor.deleteEmbeddedDocuments("ActiveEffect", [runeEvasionEffect.id]);
                console.log(`[Upgradable-Items] Removed Rune Evasion effect due to cluster change`);
            }
        }
    }

    // Remove Sharpshooter if cluster3 changed
    if (cluster3Changed && isRangedWeapon(item)) {
        if (newCluster3 !== "3") {
            const sharpshooterEntry = await findCompendiumItemByIdentifier("sharpshooter");

            if (sharpshooterEntry) {
                await safeDelete(sharpshooterEntry.id, "Sharpshooter (compendium)");
            } else {
                const fallbackSharpshooter = actor.items.find(i =>
                    i.flags?.["upgradable-items"]?.entryId === "sharpshooter" &&
                    i.flags?.["upgradable-items"]?.sourceId === item.id
                );
                if (fallbackSharpshooter) {
                    await safeDelete(fallbackSharpshooter.id, "Sharpshooter (fallback)");
                }
            }
        }
    }

    // Handle unequip/unattune cleanup
    if (unequipped || unattuned) {
        if (itemFlags.selectedSpell) await safeDelete(itemFlags.selectedSpell, "Selected Spell");
        if (itemFlags.selectedFeat) await safeDelete(itemFlags.selectedFeat, "Selected Feat");

        // Check for effects to remove
        const runeEvasionEffect = actor.effects.find(e =>
            e.origin === item.uuid &&
            e.flags?.["upgradable-items"]?.sourceItem === item.id &&
            e.flags?.["upgradable-items"]?.effectKey === "cluster2Tier1Effect"
        );

        if (runeEvasionEffect) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [runeEvasionEffect.id]);
            console.log(`[Upgradable-Items] Removed Rune Evasion effect due to unequip/unattune`);
        }
    }

    //const reequipped = !wasEquipped && willBeEquipped === true;
    //const reattuned = attunementRequired && !wasAttuned && willBeAttuned === true;

    //if (reequipped || reattuned || cluster2Changed || cluster3Changed) {
    //    await evaluateUpgradableItem(item);
    //    console.log(`[Upgradable-Items] Re-evaluated item ${item.name} after state change`);
    //}


    console.log(`[Upgradable-Items] preUpdateItem triggered for ${item.name}`, changes);
});

// Hooks - Tier 1 & Tier 3 Armor Logic
Hooks.on("dnd5e.preApplyDamage", async (actor, damageData) => {
    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;
    const cluster1 = await armor.getFlag("upgradable-items", "cluster1") ?? "0";
    const cluster2 = await armor.getFlag("upgradable-items", "cluster2") ?? "0";
    const cluster3 = await armor.getFlag("upgradable-items", "cluster3") ?? "0";
    const enhanceLvl = await armor.getFlag("upgradable-items", "enhanceLvl") ?? "0";
    const enhancementDie = await getDieFormula(enhanceLvl);

    // Cluster III Tier 1 : Armor : Falling below half HP, regain HP equal to enhancement die roll
    if (cluster1 === "3") {
        const hp = actor.system.attributes.hp.value;
        const maxHP = actor.system.attributes.hp.max;
        const predictedHP = hp - damageData;

        const wasAboveHalf = hp >= (maxHP / 2);
        const willBeBelowHalf = predictedHP < (maxHP / 2);
        if (wasAboveHalf && willBeBelowHalf) {
            const roll = new Roll(enhancementDie);
            await roll.evaluate({ async: true });
            const newHP = Math.min(predictedHP + roll.total, maxHP);
            await actor.update({ "system.attributes.hp.value": newHP });
            ChatMessage.create({
                speaker: { actor },
                content: `Rune armor flares, restores ${roll.total} HP as ${actor.name} drops below half health.`
            });
        }
    }
    // Cluster III Tier 3: Armor : Wearer equal to or below 50% hp, gains resistance to all damage until the end of next round. Enemies within 10ft make Wis DC15 or become frightened
    // TODO: Check This
    if (cluster3 === "3" && meetsUpgradableRequirements(armor)) {
        const hp = actor.system.attributes.hp.value;
        const maxHP = actor.system.attributes.hp.max;
        const used = actor.getFlag("upgradable-items", "cluster3Tier3Used");

        const incomingDamage = damageData ?? 0;
        const predictedHP = hp - incomingDamage;

        if (predictedHP <= maxHP / 2 && hp > maxHP / 2 && !used) {
            await actor.setFlag("upgradable-items", "cluster3Tier3Used", true);

            const chatContent = `${actor.name}'s armor pulses with terrain memory, granting resistance and frightening nearby enemies.`;
            ChatMessage.create({ speaker: { actor }, content: chatContent });

            const currentResistances = Array.from(actor.system.traits.dr.value ?? []);
            const newResistances = [
                "bludgeoning", "piercing", "slashing",
                "fire", "cold", "lightning", "acid", "poison",
                "necrotic", "radiant", "psychic", "thunder", "force"
            ];
            const toAdd = newResistances.filter(type => !currentResistances.includes(type));

            const resistanceChanges = toAdd.map(type => ({
                key: "system.traits.dr.value",
                mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                value: type,
                priority: 20
            }));

            const resistanceEffect = {
                label: "Buried Watcher's Mantle",
                icon: "icons/magic/symbols/elements-air-earth-fire-water.webp",
                origin: armor.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: "The wearer gains resistance to bludgeoning, piercing, slashing, fire, cold, lightning, acid, poison, necrotic, radiant, psychic, thunder, and force damage.",
                changes: resistanceChanges,
                flags: {
                    "upgradable-items": {
                        effectKey: "cluster3Tier3Resistance",
                        sourceItem: armor.id,
                        originalResistances: currentResistances
                    }
                }
            };

            await actor.createEmbeddedDocuments("ActiveEffect", [resistanceEffect]);

            // Apply Frightened condition to nearby enemies
            const originToken = actor.getActiveTokens()[0];
            const nearbyEnemies = canvas.tokens.placeables.filter(t =>
                t.actor?.type === "npc" &&
                t.document.disposition === -1 &&
                canvas.grid.measureDistance(originToken, t) <= 10
            );

            const frightenedStatus = CONFIG.statusEffects.find(e => e.id === "frightened");

            for (const token of nearbyEnemies) {
                const save = await token.actor.rollAbilitySave("wis", {
                    flavor: "Buried Watcher Fright Pulse (DC 15)",
                    dc: 15
                });

                if (save.total < 15 && frightenedStatus && token?.toggleEffect) {
                    await token.toggleEffect(frightenedStatus, { active: true });
                    ChatMessage.create({
                        speaker: { actor: token.actor },
                        content: `${token.name} is overwhelmed by fear and becomes Frightened!`
                    });
                } else {
                    ChatMessage.create({
                        speaker: { actor: token.actor },
                        content: `${token.name} resists the fear radiating from ${actor.name}'s rune armor.`
                    });
                }
            }
        }
    }
});

Hooks.on("renderChatMessage", async (msg, html, data) => {
    const itemUuid = msg.flags?.dnd5e?.roll?.itemUuid;
    const actorId = msg.speaker?.actor;
    const rollType = msg.flags?.dnd5e?.roll?.type;

    if (!itemUuid || !actorId || rollType !== "damage") return;
    const item = await fromUuid(itemUuid);
    const actor = item?.actor;

    if (!item || !actor || item.type !== "weapon") return;
    const flags = item.flags["upgradable-items"] ?? {};
    const { cluster1 = "0", cluster2 = "0", cluster3 = "0", enhanceLvl = "0" } = flags;

    const targets = Array.from(game.user?.targets ?? []);
    const targetToken = targets[0];
    const targetActor = targetToken?.actor;

    // Cluster I Tier 1 : Ranged Weapon: Tracer Whistle
    if (isRangedWeapon(item) && cluster1 === "1") {
        // TODO: Move this to applyTracerEffect method
        const chatContent = targetActor
            ? `${targetActor.name} is disoriented by the tracer whistle, suffers disadvantage on attacks for 1 round.`
            : `The tracer whistle rings out, disorienting the target, they suffer disadvantage on attacks for 1 round.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetActor) {
            const tracerEffect = {
                label: "Tracer Whistle",
                icon: "icons/magic/sonic/scream-wail-shout-teal.webp",
                origin: item.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: "Target suffers disadvantage on attack rolls for 1 round due to disorienting tracer whistle.",
                changes: [{
                    key: "system.bonuses.attack.disadvantage",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: "1",
                    priority: 20
                }],
                flags: { "upgradable-items": { sourceItem: item.id } }
            };

            const existing = targetActor.effects.find(e => e.label === "Tracer Whistle");
            if (!existing) {
                await targetActor.createEmbeddedDocuments("ActiveEffect", [tracerEffect]);
            }
        }
    }

    // Cluster II Tier 1 : Ranged Weapon: Poison
    if (isRangedWeapon(item) && cluster1 === "2") {
        const poisonType = "poison";

        const injectPoison = async (section) => {
            const types = Array.from(item.system.damage?.[section]?.types ?? []);
            if (!types.includes(poisonType)) {
                const update = {};
                update[`system.damage.${section}.types`] = [...types, poisonType];
                await item.update(update);
            }
        };

        await injectPoison("base");
        if (item.system.damage?.versatile) await injectPoison("versatile");

        const chatContent = targetActor
            ? `${targetActor.name} is poisoned by the rune-infused projectile.`
            : `The rune-infused projectile poisons its target.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetActor) {
            const damageDie = getDieFormula(enhanceLvl);
            const poisonedEffect = {
                label: "Rune Poison",
                icon: "icons/weapons/daggers/dagger-poisoned.webp",
                origin: item.uuid,
                duration: { rounds: 10, startRound: game.combat?.round ?? 0 },
                changes: [],
                description: `Take ${damageDie} poison damage at the start of each turn unless they succeed a DC 13 Constitution save at the end of their turn.`,
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        poisonDie: damageDie,
                        poisonDC: 13
                    }
                }
            };

            const existing = targetActor.effects.find(e => e.label === "Rune Poison");
            if (!existing) {
                await targetActor.createEmbeddedDocuments("ActiveEffect", [poisonedEffect]);
            }
        }
    }

    // Cluster III Tier 1 : Ranged Weapon: Slow
    if (isRangedWeapon(item) && cluster1 === "3") {
        const enhancementDie = getDieFormula(enhanceLvl);
        const roll = new Roll(enhancementDie);
        await roll.evaluate({ async: true });

        const rolledValue = roll.total;
        const rawPenalty = rolledValue * 5;

        const currentSpeed = targetActor?.system.attributes.movement.walk ?? 30;
        const newSpeed = Math.max(currentSpeed - rawPenalty, 5);
        const actualPenalty = currentSpeed - newSpeed;

        const chatContent = targetActor
            ? `${targetActor.name}'s movement is reduced by ${actualPenalty} ft from the rune projectile.`
            : `The rune projectile slows its target, reducing their movement.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetActor) {
            const existing = targetActor.effects.find(e => e.label === "Rune Slow");
            if (existing) {
                await targetActor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
            }

            const slowEffect = {
                label: "Rune Slow",
                icon: "icons/magic/control/hypnosis-mesmerism-watch.webp",
                origin: item.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: `Movement speed reduced by ${actualPenalty} ft for 1 round due to slowing projectile.`,
                changes: [{
                    key: "system.attributes.movement.walk",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: `-${actualPenalty}`,
                    priority: 20
                }],
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        rolledValue,
                        actualPenalty
                    }
                }
            };

            await targetActor.createEmbeddedDocuments("ActiveEffect", [slowEffect]);
        }
    }
    const isCritical = msg.rolls?.[0]?.options?.isCritical === true;

    // Cluster I Tier 2: Melee Weapon Crit - Push on DC 13 Str Save
    if (isMeleeWeapon(item) && cluster2 === "1" && isCritical && meetsUpgradableRequirements(item)) {
        const chatContent = targetActor
            ? `${targetActor.name} must make a DC 13 Strength save or be pushed 10 ft by the rune strike.`
            : `The rune strike forces the target to make a DC 13 Strength save or be pushed.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetActor && targetToken) {
            // Determine who should receive the save prompt
            const ownerUser = game.users.find(u =>
                u.character?.id === targetActor.id || targetActor.testUserPermission(u, "OWNER")
            ) ?? game.users.find(u => u.isGM);

            // Prompt the save roll to the correct user
            const save = await targetActor.rollAbilitySave("str", {
                flavor: "Rune Push Save (DC 13)",
                speaker: { actor: targetActor },
                dc: 13,
                rollMode: "roll",
                chatMessage: true,
                fastForward: true,
                user: ownerUser?.id
            });

            if (save.total < 13) {
                const originToken = canvas.tokens.get(msg.speaker.token);
                const ray = new Ray(originToken.center, targetToken.center);
                const dx = Math.round(Math.cos(ray.angle) * canvas.grid.size * 2); // 10 ft
                const dy = Math.round(Math.sin(ray.angle) * canvas.grid.size * 2);

                const rawX = targetToken.x + dx;
                const rawY = targetToken.y + dy;
                const snapped = canvas.grid.getSnappedPosition(rawX, rawY);

                // Overlap safeguard
                const occupied = canvas.tokens.placeables.some(other =>
                    other.id !== targetToken.id &&
                    Math.abs(other.x - snapped.x) < canvas.grid.size &&
                    Math.abs(other.y - snapped.y) < canvas.grid.size
                );

                if (!occupied) {
                    await targetToken.document.update({ x: snapped.x, y: snapped.y });
                    ChatMessage.create({
                        speaker: { actor },
                        content: `${targetActor.name} fails the save and is pushed 10 ft!`
                    });
                } else {
                    console.warn(`[Upgradable-Items] Skipped push for ${targetActor.name} to avoid overlap.`);
                    ChatMessage.create({
                        speaker: { actor },
                        content: `${targetActor.name} fails the save but cannot be pushed due to occupied space.`
                    });
                }

                await targetToken.document.update({ x: snapped.x, y: snapped.y });

                ChatMessage.create({
                    speaker: { actor },
                    content: `${targetActor.name} fails the save and is pushed 10 ft!`
                });
            } else {
                ChatMessage.create({
                    speaker: { actor },
                    content: `${targetActor.name} resists the push effect.`
                });
            }
        }
    }

    // Cluster I Tier 2: Ranged Weapon: Creates 10ft diameter area of half cover around shooter for self and allies on crit damage
    if (isRangedWeapon(item) && cluster2 === "1" && isCritical && meetsUpgradableRequirements(item)) {
        const shooterToken = canvas.tokens.get(msg.speaker.token);
        if (!shooterToken) return;

        // Create visual template
        const templateData = {
            t: "circle",
            user: game.user.id,
            x: shooterToken.center.x,
            y: shooterToken.center.y,
            distance: 7.5, // 10 ft diameter = 5 ft radius
            fillColor: "#888888",
            flags: {
                "upgradable-items": {
                    sourceItem: item.id,
                    clusterEffect: "debrisCover"
                }
            }
        };

        const createdTemplates = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
        const templateId = createdTemplates[0]?.id;

        // Store the template and round for cleanup
        const shooterId = shooterToken.id;
        const cleanupData = {
            shooterId,
            templateId,
            roundPlaced: game.combat?.round ?? 0
        };

        // Save to a global or module-level array
        if (!game.upgradableCoverCleanup) game.upgradableCoverCleanup = [];
        game.upgradableCoverCleanup.push(cleanupData);

        // Find adjacent allies within 10 ft
        const nearbyAllies = canvas.tokens.placeables.filter(t =>
            t.actor &&
            t.actor.id !== actor.id &&
            t.actor.type === "character" &&
            canvas.grid.measureDistance(shooterToken, t) <= 10
        );

        const halfCoverStatus = CONFIG.statusEffects.find(e =>
            e.id === "coverHalf" || e.id === "dnd5ecoverHalf00"
        );

        // Apply to shooter
        if (halfCoverStatus && shooterToken?.toggleEffect) {
            await shooterToken.toggleEffect(halfCoverStatus, { active: true });
        }

        // Apply to nearby allies
        for (const allyToken of nearbyAllies) {
            if (halfCoverStatus && allyToken?.toggleEffect) {
                await allyToken.toggleEffect(halfCoverStatus, { active: true });
            }
        }

        // Always show chat message
        const chatContent = nearbyAllies.length > 0
            ? `Debris erupts around ${actor.name}, granting half cover to adjacent allies.`
            : `Debris erupts around ${actor.name}, but no allies are nearby to benefit from cover.`;

        ChatMessage.create({
            speaker: { actor },
            content: chatContent
        });
    }

    // Cluster II Tier 2 : Melee Weapon: Crit - Push + Stagger
    if (isMeleeWeapon(item) && cluster2 === "2" && isCritical && meetsUpgradableRequirements(item)) {
        const chatContent = targetActor
            ? `${targetActor.name} is pushed and staggered by the rune strike. The target has half movement for 1 round.`
            : `The rune strike staggers its target, pushing them off balance. The target has half movement for 1 round.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });
        if (targetToken && targetActor) {
            const originToken = canvas.tokens.get(msg.speaker.token);
            const ray = new Ray(targetToken.center, originToken.center);
            const dx = Math.round(Math.cos(ray.angle) * -canvas.grid.size);
            const dy = Math.round(Math.sin(ray.angle) * -canvas.grid.size);

            const rawX = targetToken.x + dx;
            const rawY = targetToken.y + dy;
            const snapped = canvas.grid.getSnappedPosition(rawX, rawY);

            // Overlap safeguard
            const occupied = canvas.tokens.placeables.some(other =>
                other.id !== targetToken.id &&
                Math.abs(other.x - snapped.x) < canvas.grid.size &&
                Math.abs(other.y - snapped.y) < canvas.grid.size
            );

            if (!occupied) {
                await targetToken.document.update({ x: snapped.x, y: snapped.y });
            } else {
                console.warn(`[Upgradable-Items] Skipped push for ${targetActor.name} to avoid overlap.`);
                ChatMessage.create({
                    speaker: { actor },
                    content: `${targetActor.name} is staggered but cannot be pushed due to occupied space.`
                });
            }
            // Remove existing "Staggered" effect first
            const existingStagger = targetActor.effects.find(e => e.label === "Staggered");
            if (existingStagger) {
                await targetActor.deleteEmbeddedDocuments("ActiveEffect", [existingStagger.id]);
            }

            const staggerEffect = {
                label: "Staggered",
                icon: "icons/magic/movement/chevrons-down-yellow.webp",
                origin: item.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: chatContent,
                changes: [{
                    key: "system.attributes.movement.walk",
                    mode: CONST.ACTIVE_EFFECT_MODES.MULTIPLY,
                    value: "0.5",
                    priority: 20
                }],
                flags: { "upgradable-items": { sourceItem: item.id } }
            };
            await targetActor.createEmbeddedDocuments("ActiveEffect", [staggerEffect]);
        }
    }

    // Cluster II Tier 2 : Ranged Weapon: Prevent Dash
    if (isRangedWeapon(item) && cluster2 === "2" && meetsUpgradableRequirements(item)) {
        const chatContent = targetActor
            ? `${targetActor.name} cannot Dash this turn due to the rune projectile.`
            : `The rune projectile disrupts movement, the target cannot Dash this turn.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetActor) {
            const existingDashBlock = targetActor.effects.find(e => e.label === "Dash Blocked");
            if (existingDashBlock) {
                await targetActor.deleteEmbeddedDocuments("ActiveEffect", [existingDashBlock.id]);
            }

            const dashBlockEffect = {
                label: "Dash Blocked",
                icon: "icons/magic/control/debuff-energy-hold-teal-blue.webp",
                origin: item.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: chatContent,
                changes: [{
                    key: "system.actions.dash",
                    mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
                    value: "0",
                    priority: 20
                }],
                flags: { "upgradable-items": { sourceItem: item.id } }
            };

            await targetActor.createEmbeddedDocuments("ActiveEffect", [dashBlockEffect]);
        }
    }

    // Cluster III Tier 2: Melee Weapon — On Target Reaching 0 HP, trigger terrain pulse
    if (isMeleeWeapon(item) && cluster2 === "3" && meetsUpgradableRequirements(item)) {
        const damageTotal = msg.rolls?.[0]?.total ?? 0;
        const targetHP = targetActor?.system.attributes.hp.value ?? 1;
        const originToken = canvas.tokens.get(msg.speaker.token);
        const pulseCenter = targetToken?.center ?? originToken?.center;

        if (damageTotal >= targetHP && pulseCenter) {
            const pulseTemplate = {
                t: "circle",
                user: game.user.id,
                x: pulseCenter.x,
                y: pulseCenter.y,
                distance: 7.5,
                fillColor: "#ff0000",
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        clusterEffect: "terrainPulse"
                    }
                }
            };

            await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [pulseTemplate]);

            const nearbyTokens = canvas.tokens.placeables.filter(t =>
                t.actor &&
                t.actor.type === "npc" &&
                t.document.disposition === -1 &&
                t.actor.system.attributes.hp.value > 0 &&
                canvas.grid.measureDistance(pulseCenter, t.center) <= 7.5
            );


            const message = targetActor
                ? `Terrain pulse triggered! Enemies within 15 ft of ${targetActor.name} lose reactions for 1 round.`
                : `Terrain pulse triggered! Enemies within 15 ft of the attacker lose reactions for 1 round.`;

            for (const token of nearbyTokens) {
                const targetActor = token.actor;
                const existing = targetActor.effects.find(e =>
                    e.label === "Reaction Blocked" &&
                    e.origin === item.uuid
                );
                if (existing) {
                    await targetActor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
                }

                const reactionBlock = {
                    label: "Reaction Blocked",
                    icon: "icons/magic/control/debuff-chains-shackle-movement-red.webp",
                    origin: item.uuid,
                    duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                    description: message,
                    changes: [{
                        key: "system.actions.reaction",
                        mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
                        value: "0",
                        priority: 20
                    }],
                    flags: { "upgradable-items": { sourceItem: item.id } }
                };

                await targetActor.createEmbeddedDocuments("ActiveEffect", [reactionBlock]);
            }

            ChatMessage.create({ speaker: { actor }, content: message });
        }
    }

    // Cluster III Tier 2: Ranged Weapon : Damage to target or empty space, Reveal Illusions/concealment/hide within 15ft radius of impact
    if (isRangedWeapon(item) && cluster2 === "3" && meetsUpgradableRequirements(item)) {
        const impactX = targetToken?.center?.x ?? null;
        const impactY = targetToken?.center?.y ?? null;

        let templatePlaced = false;
        if (impactX && impactY) {
            // Target was hit — place template at impact location
            const templateData = {
                t: "circle",
                user: game.user.id,
                x: impactX,
                y: impactY,
                distance: 7.5, // 15 ft diameter
                fillColor: "#00ffff",
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        clusterEffect: "revealIllusions"
                    }
                }
            };

            await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            templatePlaced = true;

            ChatMessage.create({
                speaker: { actor },
                content: `Illusion pulse triggered! Terrain and hidden targets revealed in 15 ft radius.`
            });

        } else {
            if (!templatePlaced) {

                // No target selected — attach template to cursor for manual placement
                ui.notifications.info("Click to place the illusion-revealing pulse.");

                const templateData = {
                    t: "circle",
                    user: game.user.id,
                    distance: 7.5,
                    x: canvas.mousePosition.x,
                    y: canvas.mousePosition.y,
                    fillColor: "#00ffff",
                    flags: {
                        "upgradable-items": {
                            sourceItem: item.id,
                            clusterEffect: "revealIllusions"
                        }
                    }
                };

                const doc = new MeasuredTemplateDocument(templateData, { parent: canvas.scene });
                const template = new game.dnd5e.canvas.AbilityTemplate(doc);
                template.drawPreview(); // attaches to cursor for placement
                templatePlaced = true;
            };
        }
    }

    // Cluster I Tier 3: Melee Weapon : On Crit, Allies within 20ft of Attacker gain +2 to hit against the struck target for 2 rounds.
    if (isMeleeWeapon(item) && cluster3 === "1" && isCritical && meetsUpgradableRequirements(item)) {
        let originToken = canvas.tokens.get(msg.speaker.token);
        if (!originToken) {
            originToken = actor.getActiveTokens()[0];
            if (!originToken) {
                ChatMessage.create({
                    speaker: { actor },
                    content: `Rune Precision could not be applied — no valid attacker token found.`
                });
                return;
            }
        }

        const targetName = targetActor?.name ?? "the struck target";
        const chatContent = targetActor
            ? `Allies within 20 ft of ${actor.name} gain +2 to attack rolls against ${targetName} for 2 rounds.`
            : `Allies within 20 ft gain +2 to attack rolls against the struck target for 2 rounds.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });
        const nearbyAllies = canvas.tokens.placeables.filter(t =>
            t.actor?.id !== actor.id &&
            t.actor?.type === "character" &&
            canvas.grid.measureDistance(originToken, t) <= 20
        );
        for (const allyToken of nearbyAllies) {
            const allyActor = allyToken.actor;

            // Remove existing effect if present
            const existing = allyActor.effects.find(e =>
                e.label === "Rune Precision" &&
                e.origin === item.uuid
            );
            if (existing) await allyActor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
            // Apply effect regardless of target
            const precisionEffect = {
                label: "Rune Precision",
                icon: "icons/magic/perception/third-eye-blue-red.webp",
                origin: item.uuid,
                duration: { rounds: 2, startRound: game.combat?.round ?? 0 },
                description: `You gain +2 to attack rolls against ${targetName} due to the rune strike.`,
                changes: [{
                    key: "system.bonuses.attack",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: "2",
                    priority: 20
                }],
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        targetId: targetActor?.id ?? null
                    }
                }
            };

            await allyActor.createEmbeddedDocuments("ActiveEffect", [precisionEffect]);
        }
    }

    // Cluster I Tier 3: Ranged Weapon : Firing at Target or Empty space on crit, create 15ft Diameter area that pulls all creatures 5ft closer to the center (no Overlap)
    if (isRangedWeapon(item) && cluster3 === "1" && isCritical && meetsUpgradableRequirements(item)) {
        const center = targetToken?.center ?? canvas.mousePosition;

        const chatContent = targetToken
            ? `Rune pulse draws nearby NPCs 5 ft closer to ${targetToken.name}.`
            : `Rune pulse draws nearby NPCs 5 ft closer to the selected impact zone.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });
        let templatePlaced = false;
        if (targetToken) {
            // Targeted location — place template and pull NPCs
            const templateData = {
                t: "circle",
                user: game.user.id,
                x: center.x,
                y: center.y,
                distance: 12.5, // 25 ft diameter
                fillColor: "#00ffff",
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        clusterEffect: "runePull"
                    }
                }
            };

            await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            templatePlaced = true;

            const centerPoint = new PIXI.Point(center.x, center.y);
            const affectedTokens = canvas.tokens.placeables.filter(t =>
                t.actor?.type === "npc" &&
                t.document.disposition === -1 &&
                canvas.grid.measureDistance(centerPoint, t.center) <= 12.5 &&
                canvas.grid.measureDistance(centerPoint, t.center) > 5
            );

            for (const token of affectedTokens) {
                const ray = new Ray(centerPoint, token.center);
                const dx = Math.round(Math.cos(ray.angle) * canvas.grid.size);
                const dy = Math.round(Math.sin(ray.angle) * canvas.grid.size);

                const rawX = token.x - dx;
                const rawY = token.y - dy;
                const snapped = canvas.grid.getSnappedPosition(rawX, rawY);
                const newX = snapped.x;
                const newY = snapped.y;

                // Safeguard: prevent overlap or invalid movement
                const occupied = canvas.tokens.placeables.some(other =>
                    other.id !== token.id &&
                    Math.abs(other.x - newX) < canvas.grid.size &&
                    Math.abs(other.y - newY) < canvas.grid.size
                );

                if (!occupied) {
                    await token.document.update({ x: newX, y: newY });
                } else {
                    console.warn(`[Upgradable-Items] Skipped movement for ${token.name} to avoid overlap.`);
                }
            }

        } else {
            if (!templatePlaced) {

                // No target — attach template to cursor for manual placement
                ui.notifications.info("Click to place the rune pulse zone.");

                const templateData = {
                    t: "circle",
                    user: game.user.id,
                    distance: 12.5,
                    x: canvas.mousePosition.x,
                    y: canvas.mousePosition.y,
                    fillColor: "#00ffff",
                    flags: {
                        "upgradable-items": {
                            sourceItem: item.id,
                            clusterEffect: "runePull"
                        }
                    }
                };

                const doc = new MeasuredTemplateDocument(templateData, { parent: canvas.scene });
                const template = new game.dnd5e.canvas.AbilityTemplate(doc);
                template.drawPreview(); // attaches to cursor
                templatePlaced = true;
            };
        }
    }

    // Cluster II Tier 3: Melee Weapon : On crit Damage Roll, Target makes Dex 15 DC and restrained on failure. Also takes necrotic damage equal to enhancement die value
    if (isMeleeWeapon(item) && cluster2 === "3" && isCritical && meetsUpgradableRequirements(item)) {
        const originToken = canvas.tokens.get(msg.speaker.token);
        const targetName = targetActor?.name ?? "the target";

        const chatContent = targetActor
            ? `${targetName} must make a DC 15 Dexterity save or be restrained by spectral roots.`
            : `The terrain erupts with spectral roots. The target must make a DC 15 Dexterity save or be restrained.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (!targetActor || !targetToken) return;

        const save = await targetActor.rollAbilitySave("dex", {
            flavor: "Gravebind Tremor (DC 15)",
            dc: 15
        });

        if (save.total < 15) {
            // Apply native Restrained condition
            const restrainedStatus = CONFIG.statusEffects.find(e => e.id === "restrained");
            if (restrainedStatus && targetToken?.toggleEffect) {
                await targetToken.toggleEffect(restrainedStatus, { active: true });
            }

            // Add custom Gravebound effect for necrotic damage
            const targetName = targetActor?.name ?? "the target";

            const graveboundEffect = {
                label: "Gravebound",
                icon: "icons/magic/nature/root-vine-fire-entangled-hand.webp",
                origin: item.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                description: `Spectral roots erupt from the terrain, restraining ${targetName}. At the start of their turn, they take necrotic damage equal to the rune's enhancement die.`,
                flags: {
                    "upgradable-items": {
                        sourceItem: item.id,
                        damageDie: getDieFormula(enhanceLvl),
                        damageType: "necrotic"
                    }
                }
            };

            await targetActor.createEmbeddedDocuments("ActiveEffect", [graveboundEffect]);
        }
    }

    // Cluster II Tier 3: Ranged Weapon : Create 15ft radius area  of poison damage. Creatures in area make Con DC14 save or are poisoned. Cloud lasts 3 rounds and moves 5ft each round.
    if (isRangedWeapon(item) && cluster3 === "2" && meetsUpgradableRequirements(item)) {
        const center = targetToken?.center ?? canvas.mousePosition;

        const damageDie = getDieFormula(enhanceLvl);
        const templateData = {
            t: "circle",
            user: game.user.id,
            x: center.x,
            y: center.y,
            distance: 7.5,
            fillColor: "#228B22",
            flags: {
                "upgradable-items": {
                    sourceItem: item.id,
                    clusterEffect: "sporewake",
                    roundsRemaining: 3,
                    damageDie
                }
            }
        };

        const chatContent = targetActor
            ? `Sporewake cloud erupts around ${targetActor.name}, infecting terrain with poisonous spores.`
            : `Sporewake cloud erupts, infecting terrain with poisonous spores.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (targetToken) {
            const [templateDoc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            await triggerSporewake(templateDoc, damageDie);
        } else {
            ui.notifications.info("Click to place the Sporewake cloud.");
            const doc = new MeasuredTemplateDocument(templateData, { parent: canvas.scene });
            const preview = new game.dnd5e.canvas.AbilityTemplate(doc);
            preview.drawPreview();

            // Hook into placement to apply effect
            Hooks.once("createMeasuredTemplate", async (templateDoc) => {
                if (templateDoc.flags?.["upgradable-items"]?.clusterEffect === "sporewake") {
                    await triggerSporewake(templateDoc, damageDie);
                }
            });
        }
    }

    // Cluster III Tier 3: Melee Weapon : Create Phantom Illusion giving attacker advantage on next attack
    if (isMeleeWeapon(item) && cluster3 === "3" && isCritical && meetsUpgradableRequirements(item)) {
        const originToken = canvas.tokens.get(msg.speaker.token);
        const targetName = targetActor?.name ?? "the target";

        const chatContent = targetToken
            ? `A phantom illusion flickers into existence beside ${targetName}, distracting them. ${actor.name} gains advantage on their next attack.`
            : `A phantom illusion flickers into existence beside you, distracting them. You gain advantage on your next attack.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        const existing = actor.effects.find(e =>
            e.label === "Phantom Advantage" &&
            e.origin === item.uuid
        );
        if (existing) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
        }

        const phantomEffect = {
            label: "Phantom Advantage",
            icon: "icons/skills/targeting/target-glowing-yellow.webp",
            origin: item.uuid,
            duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
            description: "You have advantage on your next attack due to phantom distraction.",
            changes: [{
                key: "flags.upgradable-items.advantageNextAttack",
                mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
                value: "1",
                priority: 20
            }],
            flags: {
                "upgradable-items": {
                    sourceItem: item.id
                }
            }
        };

        await actor.createEmbeddedDocuments("ActiveEffect", [phantomEffect]);
    }

});

Hooks.on("createMeasuredTemplate", async (templateDoc) => {
    const template = canvas.templates.get(templateDoc.id);
    if (!template) return;

    const flags = template.flags?.["upgradable-items"];
    if (!flags || flags.clusterEffect !== "sporewake") return;

    const damageDie = flags.damageDie ?? "1d4";

    const affectedTokens = canvas.tokens.placeables.filter(t =>
        t.actor?.type === "npc" &&
        t.document.disposition === -1 &&
        canvas.grid.measureDistance(template.center, t.center) <= template.document.distance
    );

    for (const token of affectedTokens) {
        await applySporewakeEffect(token.actor, template);
    }
});


Hooks.on("combatTurnStart", async (combat) => {
    const actor = combat.combatant.actor;
    const token = actor?.getActiveTokens()[0];
    if (!actor || !token) return;

    // Initial exposure: check if inside any Sporewake template
    const templates = canvas.templates.placeables.filter(t =>
        t.flags?.["upgradable-items"]?.clusterEffect === "sporewake"
    );

    for (const template of templates) {
        const distance = canvas.grid.measureDistance(token.center, template.center);
        if (distance <= template.document.distance) {
            const alreadyPoisoned = actor.effects.some(e =>
                e.label === "Poisoned (Sporewake)" && e.origin === template.uuid
            );
            if (!alreadyPoisoned) {
                await applySporewakeEffect(actor, template);
            }
        }
    }

    // Lingering damage: process poisoned effect if present
    const lingeringEffect = actor.effects.find(e =>
        e.label === "Poisoned (Sporewake)" &&
        e.flags?.["upgradable-items"]?.damageDie
    );

    if (lingeringEffect) {
        const damageDie = lingeringEffect.flags["upgradable-items"].damageDie;
        const roll = await new Roll(damageDie).evaluate({ async: true });
        await actor.applyDamage(roll.total);

        const save = await actor.rollAbilitySave("con", {
            flavor: "Sporewake lingering spores (DC 14)",
            dc: 14
        });

        const chatContent = save.total < 14
            ? `${actor.name} inhales lingering spores, takes ${roll.total} poison damage and remains poisoned.`
            : `${actor.name} resists the lingering spores and takes no further damage.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

        if (save.total >= 14) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [lingeringEffect.id]);
        }
    }
});


Hooks.on("updateToken", async (tokenDoc, changes, options, userId) => {
    const token = canvas.tokens.get(tokenDoc.id);
    if (!token || !changes.x && !changes.y) return;

    const templates = canvas.templates.placeables.filter(t =>
        t.flags?.["upgradable-items"]?.clusterEffect === "sporewake"
    );

    for (const template of templates) {
        const distance = canvas.grid.measureDistance(token.center, template.center);
        if (distance <= template.document.distance) {
            await applySporewakeEffect(token.actor, template);
        }
    }
});


Hooks.on("dnd5e.restCompleted", async (actor, restType) => {
    await actor.unsetFlag("upgradable-items", "cluster3Tier3Used");
    await actor.unsetFlag("upgradable-items", "cluster3Tier2Used");
    await actor.unsetFlag("upgradable-items", "guardianRushUsed");
});
Hooks.on("deleteCombat", async combat => {
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        if (actor) {
            await actor.unsetFlag("upgradable-items", "cluster3Tier2Used");
        }
    }
});


Hooks.on("updateCombat", async (combat, changed, options, userId) => {
    const currentToken = canvas.tokens.get(combat.current.tokenId);
    const actor = currentToken?.actor;
    if (!actor) return;

    const poisonEffect = actor.effects.find(e => e.label === "Rune Poison");
    if (!poisonEffect) return;

    const poisonDie = poisonEffect.flags["upgradable-items"]?.poisonDie ?? "1d4";
    const poisonDC = poisonEffect.flags["upgradable-items"]?.poisonDC ?? 13;

    // Apply poison damage
    const roll = new Roll(poisonDie);
    await roll.evaluate({ async: true });
    await actor.applyDamage(roll.total);

    ChatMessage.create({
        speaker: { actor },
        content: `${actor.name} suffers ${roll.total} poison damage from Rune Poison.`
    });

    // Prompt saving throw
    const saveRoll = await actor.rollAbilitySave("con", { flavor: "Rune Poison Save (DC 13)" });
    if (saveRoll.total >= poisonDC) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [poisonEffect.id]);
        ChatMessage.create({
            speaker: { actor },
            content: `${actor.name} resists the poison and ends the effect.`
        });
    }

    const gravebound = actor.effects.find(e => e.label === "Gravebound");
    if (gravebound) {
        const die = gravebound.flags["upgradable-items"]?.damageDie ?? "1d4";
        const roll = new Roll(die);
        await roll.evaluate({ async: true });
        await actor.applyDamage(roll.total);

        ChatMessage.create({
            speaker: { actor },
            content: `${actor.name} suffers ${roll.total} necrotic damage from Gravebind Tremor.`
        });
    }
});

// Hooks - Cooldown Reset on Rest
Hooks.on("dnd5e.restCompleted", async (actor, restType) => {
    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;
    await actor.unsetFlag("upgradable-items", "cluster3Tier3Used");
    await actor.unsetFlag("upgradable-items", "cluster3Tier2Used");
    await actor.unsetFlag("upgradable-items", "rune-reflected");
    await actor.unsetFlag("upgradable-items", "imposeDisadvantage");
});

Hooks.on("updateActor", async (actor, changes) => {
    upgradableAddCache.clear();
    upgradableRenderCache.clear();
    evaluationQueue.clear();

    const newHP = getProperty(changes, "system.attributes.hp.value");
    if (newHP === undefined) return;

    const maxHP = actor.system.attributes.hp.max;
    const isAboveHalf = newHP > (maxHP / 2);

    const effect = actor.effects.find(e =>
        e.flags?.["upgradable-items"]?.effectKey === "cluster3Tier3Resistance"
    );
    if (effect && isAboveHalf) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);

        const originalResistances = actor.getFlag("upgradable-items", "originalResistances") ?? [];
        await actor.update({ "system.traits.dr.value": originalResistances });

        await actor.unsetFlag("upgradable-items", "originalResistances");
        await actor.unsetFlag("upgradable-items", "cluster3Tier3Used");

        ChatMessage.create({
            speaker: { actor },
            content: `${actor.name}'s terrain memory fades as their vitality returns. Resistances restored.`
        });
    }
});

Hooks.on("createActiveEffect", async (effect, options, userId) => {
    const actor = effect.parent;
    if (!actor || effect.label !== "Prone") return;

    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;

    const flags = armor.flags["upgradable-items"] ?? {};
    const { cluster1 = "0", enhanceLvl = "1" } = flags;
    if (cluster1 !== "2") return;

    const meetsRequirements = meetsUpgradableRequirements(armor);
    if (!meetsRequirements) return;

    const hp = actor.system.attributes.hp.value;
    const maxHP = actor.system.attributes.hp.max;
    const isBelowHalf = hp < maxHP / 2;
    if (!isBelowHalf) return;

    const enhancementDie = getDieFormula(enhanceLvl);
    const roll = new Roll(enhancementDie);
    await roll.evaluate({ async: true });

    await actor.applyDamage(-roll.total);
    ChatMessage.create({
        speaker: { actor },
        content: `Rune armor pulses, restores ${roll.total} HP as ${actor.name} falls prone while wounded.`
    });
});


// Hooks - Sheet Logic Injection
Hooks.on("renderItemSheet5e", async (app, html, data) => {
    try {
        const locale = game.i18n.translations[game.i18n.lang]?.["upgradable-items"]?.SOLVARIS?.Labels || {};
        const enhanceLvlObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["EnhancementLevels"] ?? {};
        const enhanceLvls = Object.entries(enhanceLvlObj).map(([id, label]) => ({ id, label }));
        const clusterObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["Cluster"] ?? {};
        const runeClusters = Object.entries(clusterObj).map(([id, label]) => ({ id, label }));
        const itemFlags = foundry.utils.getProperty(app.object, "flags.upgradable-items") || {};

        const spells = await getCompendiumItems("spell");
        const feats = await getCompendiumItems("feat");
        const selectedSpell = itemFlags.selectedSpell ?? "";
        const selectedFeat = itemFlags.selectedFeat ?? "";
        const itemType = app.object.type;
        const actionType = app.object.system?.actionType ?? "";

        const showUpgrades =
            itemType === "equipment" ||
            (itemType === "weapon" && ["mwak", "rwak"].includes(actionType));

        const detailsTab = html.find('.tab.details[data-tab="details"]');
        if (!detailsTab.length) return;
        const sheetBody = detailsTab.children().first();
        if (!sheetBody.length) return;
        const fieldsets = sheetBody.find('fieldset:not(.upitab-extension)');
        const target = fieldsets.length ? fieldsets.last() : sheetBody;

        const abilityKeys = ["str", "dex", "con", "int", "wis", "cha"];

        const empowermentOptions = abilityKeys.map(key => ({
            key,
            label: key.toUpperCase(),
            value: parseInt(itemFlags[`empowerment-${key}`] ?? "0")
        }));

        const boostRange = Array.from({ length: 11 }, (_, i) => i); // [0–10]

        const selectedRunes = {
            enhanceLvl: itemFlags.enhanceLvl ?? "0",
            cluster1: itemFlags.cluster1 ?? "0",
            cluster2: itemFlags.cluster2 ?? "0",
            cluster3: itemFlags.cluster3 ?? "0"
        };

        const htmlload = await renderTemplate("modules/upgradable-items/templates/upitab-template.hbs", {
            ...data,
            fieldIdPrefix: `upitab-${app.id}-`,
            enhanceLvls,
            runeClusters,
            selectedRunes,
            spells,
            feats,
            selectedSpell,
            selectedFeat,
            showUpgrades,
            empowermentOptions,
            boostRange
        });

        const injectedHtml = $(htmlload);

        // Handle stat boost changes
        abilityKeys.forEach(ability => {
            injectedHtml.find(`[data-property="empowerment-${ability}"]`).on("change", async (event) => {
                const selectedBonus = parseInt(event.target.value);
                const actor = app.object.actor;
                if (!actor) return;

                const baseValue = actor.system.abilities[ability]?.value ?? 0;
                const maxAllowedBonus = Math.max(0, 30 - baseValue);

                let appliedBonus = selectedBonus;

                if (baseValue + selectedBonus > 30) {
                    appliedBonus = maxAllowedBonus;
                    event.target.value = appliedBonus;

                    ui.notifications.warn(`${ability.toUpperCase()} bonus capped at +${appliedBonus} (max stat value is 30).`);
                }

                await app.object.setFlag("upgradable-items", `empowerment-${ability}`, appliedBonus);
                await updateRunicEmpowermentEffect(app.object);
            });
        });

        // Handle rune cluster changes
        injectedHtml.find('[data-property]').on("change", async (event) => {
            const key = event.currentTarget.dataset.property;
            const selectedId = event.currentTarget.value;

            try {
                await app.object.setFlag("upgradable-items", key, selectedId);
                await applyUpgradableEnhancement(app.object);
            } catch (err) {
                console.error(`Failed to set ${key}:`, err);
            }
        });

        // Handle spell selection
        injectedHtml.find('[name="flags.upgradable-items.selectedSpell"]').on("change", async (event) => {
            const newValue = event.target.value;
            const prevValue = itemFlags.selectedSpell;
            await app.object.setFlag("upgradable-items", "selectedSpell", newValue);

            const actor = app.object.actor;
            const isEquipped = app.object.system.equipped;
            const isAttuned = app.object.system.attunement;
            const requiresEquipped = app.object.flags?.["upgradable-items"]?.requiresEquipped;
            const requiresAttunement = app.object.flags?.["upgradable-items"]?.requiresAttunement;

            const meetsRequirements =
                (!requiresEquipped || isEquipped) &&
                (!requiresAttunement || isAttuned === CONFIG.DND5E.attunementTypes.REQUIRED);

            if (!actor) return;

            if (prevValue) {
                await removeItemFromActor(actor, prevValue, app.object);
            }

            if (newValue && meetsRequirements) {
                await addItemToActor(actor, newValue, app.object);
            }
            await app.object.sheet.render(false);
        });

        // Handle feat selection
        injectedHtml.find('[name="flags.upgradable-items.selectedFeat"]').on("change", async (event) => {
            const newValue = event.target.value;
            const prevValue = itemFlags.selectedFeat;
            await app.object.setFlag("upgradable-items", "selectedFeat", newValue);

            const actor = app.object.actor;
            const isEquipped = app.object.system.equipped;
            const isAttuned = app.object.system.attunement;
            const requiresEquipped = app.object.flags?.["upgradable-items"]?.requiresEquipped;
            const requiresAttunement = app.object.flags?.["upgradable-items"]?.requiresAttunement;

            const meetsRequirements =
                (!requiresEquipped || isEquipped) &&
                (!requiresAttunement || isAttuned === CONFIG.DND5E.attunementTypes.REQUIRED);

            if (!actor) return;

            if (prevValue) {
                await removeItemFromActor(actor, prevValue, app.object);
            }

            if (newValue && meetsRequirements) {
                await addItemToActor(actor, newValue, app.object);
            }
            await app.object.sheet.render(false);

        });

        // Handle enhancement level changes
        injectedHtml.find('[name="flags.upgradable-items.enhanceLvl"]').on("change", async (event) => {
            const newValue = event.target.value;
            const prevValue = itemFlags.enhanceLvl ?? "0";
            await app.object.setFlag("upgradable-items", "enhanceLvl", newValue);

            const actor = app.object.actor;
            if (!actor) return;

            await evaluateUpgradableItem(app.object);
            await applyUpgradableEnhancement(app.object);
        });

        // Inject into sheet
        target.after(injectedHtml);
    } catch (error) {
        console.error("Upitab Injection Error:", error);
    }
});

Hooks.on("updateItem", async (item, changes) => {
    if (!item.flags?.["upgradable-items"]) return;
    await evaluateUpgradableItem(item);
    await applyUpgradableEnhancement(item);
    // Ensure empowerment effect updates on equip/attune changes
    if (
        changes?.system?.equipped !== undefined ||
        changes?.system?.attunement !== undefined
    ) {
        await updateRunicEmpowermentEffect(item);
    }

});

Hooks.on("renderActorSheet", async (sheet, html, data) => {
    const actor = sheet.actor;
    if (!actor || upgradableRenderCache.has(actor.id)) return;

    upgradableRenderCache.add(actor.id);
    setTimeout(() => upgradableRenderCache.delete(actor.id), 500); // debounce

    for (const item of actor.items) {
        if (item.flags?.["upgradable-items"]) {
            await evaluateUpgradableItem(item);
        }
    }
});

console.log('[upgradable-items] | Loading Complete');