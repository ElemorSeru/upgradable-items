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

async function applySporewakeEffect(targetActor, template) {
    const die = template.flags["upgradable-items"]?.damageDie ?? "1d4";
    const roll = await new Roll(die).evaluate({ async: true });
    await targetActor.applyDamage(roll.total);

    const save = await targetActor.rollAbilitySave("con", {
        flavor: "Sporewake Poison Cloud (DC 14)",
        dc: 14
    });

    if (save.total < 14) {
        await targetActor.createEmbeddedDocuments("ActiveEffect", [{
            label: "Poisoned (Sporewake)",
            icon: "icons/magic/nature/spore-cloud-green.webp",
            origin: template.uuid,
            duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
            flags: { core: { statusId: "Poisoned" }, "upgradable-items": { sourceTemplate: template.id } }
        }]);
    }

    const chatContent = `${targetActor.name} is exposed to the Sporewake cloud, takes ${roll.total} poison damage${save.total < 14 ? " and is poisoned." : "."}`;
    ChatMessage.create({ speaker: { actor: targetActor }, content: chatContent });
}

async function applyTracerWhistleEffect(targetActor, sourceActor, sourceItem) {
    const tracerEffect = {
        label: "Tracer Whistle",
        icon: "icons/magic/sound/echo-wave-shock-blue.webp",
        origin: sourceItem.uuid,
        duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
        description: "Disoriented by the tracer whistle, you suffer disadvantage on attack rolls for 1 round.",
        changes: [{
            key: "flags.upgradable-items.disadvantageAttack",
            mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
            value: "1",
            priority: 20
        }],
        flags: {
            "upgradable-items": {
                sourceItem: sourceItem.id
            }
        }
    };

    const existing = targetActor.effects.find(e => e.label === "Tracer Whistle");
    if (!existing) {
        await targetActor.createEmbeddedDocuments("ActiveEffect", [tracerEffect]);
        ChatMessage.create({
            speaker: { actor: sourceActor },
            content: `${targetActor.name} is disoriented by the tracer whistle, suffers disadvantage on attacks for 1 round.`
        });
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
                    identifier: entry.system?.identifier ?? null
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


// Logic Functions //
// Logic Functions - Check item and enhancements to be added for eqipping/attuning
async function evaluateUpgradableItem(item) {
    const actor = item.actor;
    if (!actor || !item.flags?.["upgradable-items"]) return;

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
            console.log(`[Item Upgrades] Removed ${existingEffects.length} enhancement effects from ${item.name}`);
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
            console.log(`[Item Upgrades] Applied enhancement effect: ${effectLabel}`);
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
    if (item.type === "equipment" && item.getFlag("upgradable-items", "cluster2") === "1") {
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;

        const effectLabel = "Rune Evasion";
        const existing = actor.effects.find(e =>
            e.label === effectLabel &&
            e.origin === item.uuid
        );

        if (meetsRequirements && !existing) {
            const evasionEffect = {
                label: effectLabel,
                icon: "icons/magic/movement/trail-streak-impact-blue.webp",
                origin: item.uuid,
                duration: { seconds: 3600 }, // optional: 1 hour placeholder
                changes: [],
                description: "You can move through allies without provoking opportunity attacks once per short rest.",
                flags: {
                    "upgradable-items": { sourceItem: item.id }
                }
            };
            await actor.createEmbeddedDocuments("ActiveEffect", [evasionEffect]);
        } else if (!meetsRequirements && existing) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
        }
    }

    // Cluster II Tier 2 : Armor : Grant Mobile feat
    const armorCluster2 = item.getFlag("upgradable-items", "cluster2");
    if (item.type === "equipment" && armorCluster2 === "2") {
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;

        const findGrantedItem = (entryId) => actor.items.find(i =>
            i.flags?.["upgradable-items"]?.sourceId === item.id &&
            i.flags?.["upgradable-items"]?.entryId === entryId
        );

        if (meetsRequirements && armorCluster2 === "2" && !findGrantedItem("mobile")) {

            const mobileEntry = await findCompendiumItemByIdentifier("mobile");

            if (!mobileEntry) {
                console.warn("[Upgradable] Mobile feat not found by identifier.");
                return;
            }

            const compRef = `${mobileEntry.pack}.${mobileEntry.id}`;
            await addItemToActor(actor, compRef, item);
        } else if (armorCluster2 !== "2" || !meetsRequirements) {

            const mobileEntry = await findCompendiumItemByIdentifier("mobile");
            if (mobileEntry) {
                await removeItemFromActor(actor, mobileEntry.id, item); // entryId = mobileEntry.id, item = sourceItem
            }
        }
    }

    // Cluster III Tier 3: Armor : When <= 10% of HP, Gain aura to impose disadvantage when being attacked
    if (item.type === "equipment" && item.getFlag("upgradable-items", "cluster3") === "3") {
        const actor = item.actor;
        const hp = actor.system.attributes.hp;
        const hpPercent = (hp.value / hp.max) * 100;
        const meetsRequirements = meetsUpgradableRequirements(item);

        const effectLabel = "Illusory Aura";
        const existing = actor.effects.find(e =>
            e.label === effectLabel &&
            e.origin === item.uuid
        );

        if (meetsRequirements && hpPercent <= 10 && !existing) {
            const auraEffect = {
                label: effectLabel,
                icon: "icons/magic/defensive/shield-barrier-deflect-teal.webp",
                origin: item.uuid,
                duration: { rounds: 9999 }, // indefinite until removed
                description: "Enemies have disadvantage on ranged attacks against you due to illusory aura.",
                changes: [{
                    key: "flags.upgradable-items.disadvantageRangedAgainstSelf",
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
            await actor.createEmbeddedDocuments("ActiveEffect", [auraEffect]);
        } else if ((hpPercent > 10 || !meetsRequirements) && existing) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
        }
    }

    // Cluster III Tier 3: Ranged Weapon : Gain Sharpshooter Feat allowing ignore of cover to target. 
    const rangedCluster3 = item.getFlag("upgradable-items", "cluster3");
    if (item.type === "weapon" && isRangedWeapon(item) && rangedCluster3 === "3") {
        const meetsRequirements = meetsUpgradableRequirements(item);
        const actor = item.actor;

        const findGrantedItem = (entryId) => actor.items.find(i =>
            i.flags?.["upgradable-items"]?.sourceId === item.id &&
            i.flags?.["upgradable-items"]?.entryId === entryId
        );

        if (meetsRequirements && rangedCluster3 === "3" && !findGrantedItem("sharpshooter")) {
            const sharpshooterEntry = await findCompendiumItemByIdentifier("sharpshooter");

            if (!sharpshooterEntry) {
                console.warn("[Upgradable] Sharpshooter feat not found by identifier.");
                return;
            }
            const compRef = `${sharpshooterEntry.pack}.${sharpshooterEntry.id}`;
            await addItemToActor(actor, compRef, item);

        } else if (rangedCluster3 !== "3" || !meetsRequirements) {
            console.log("In Sharpshooter Remove");
            const sharpshooterEntry = await findCompendiumItemByIdentifier("sharpshooter");
            if (sharpshooterEntry) {
                console.log("In Sharpshooter Remove 2");
                console.log(sharpshooterEntry);
                await removeItemFromActor(actor, sharpshooterEntry.id, item);
            }
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
    setTimeout(() => enhancementCallCache.delete(cacheKey), 300); // clears after 300ms

    const flags = item.flags["upgradable-items"] ?? {};
    const { enhanceLvl = "0", cluster1 = "0", cluster2 = "0", cluster3 = "0" } = flags;

    const meetsRequirements = meetsUpgradableRequirements(item);

    const damageDie = DAMAGE_DIE_MAP[enhanceLvl] ?? "1d4";

    const damageTypeMap = CLUSTER_DAMAGE_TYPES[cluster1] ?? [];

    const damageTypes = damageTypeMap[cluster1] ?? [];
    const damageType = damageTypes.length > 0
        ? damageTypes[Math.floor(Math.random() * damageTypes.length)]
        : null;

    const enhancementDie = damageDie && damageType ? damageDie : null;
    const enhancementTypes = Object.values(damageTypeMap).flat(); // All possible enhancement types

    const updates = {};

    const updateSection = (section) => {
        const bonus = item.system.damage?.[section]?.bonus ?? "";
        const types = Array.from(item.system.damage?.[section]?.types ?? []);

        const cleanedBonus = bonus.replace(/(1d4|1d6|1d8)/g, "").trim();
        const newBonus = meetsRequirements && enhancementDie ? enhancementDie : cleanedBonus || "";

        const filteredTypes = types.filter(t => !enhancementTypes.includes(t));
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
            console.log(`[Upgradable] Enhancement updated for ${item.name}`, updates);
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

    //await roll.toMessage({
    //    speaker: ChatMessage.getSpeaker({ actor }),
    //    flavor: `${item.name} unleashes ${roll.total} ${damageType} damage from its Cluster I rune.`,
    //    rollMode: game.settings.get("core", "rollMode")
    //});
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
        console.warn(`[Upgradable] Pack not found: ${packId}`);
        return;
    }

    console.log(`[Upgradable] Fetching entryId: ${entryId} from pack: ${packId}`);
    const entry = await pack.getDocument(entryId);
    if (!entry) {
        console.warn(`[Upgradable] Entry not found in pack: ${entryId}`);
        return;
    }

    // Debounce logic
    const cacheKey = `${actor.id}::${sourceItem.id}::${entry.id}`;
    if (upgradableAddCache.has(cacheKey)) {
        console.log(`[Upgradable] Skipping cached add for ${entry.name}`);
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
        //console.log(`[Upgradable] Skipping duplicate: ${entry.name}`);
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
    console.log(`[Upgradable] Added item: ${clone.name} to ${actor.name}`);
}

// Logic Functions - Remove item from actor added by Spell/Feat Options
async function removeItemFromActor(actor, compRef, sourceItem) {
    if (!actor || !compRef || !sourceItem) return;

    const parts = compRef.split(".");
    const entryId = parts.at(-1);
    const cacheKey = `${actor.id}::${sourceItem.id}::${entryId}`;
    if (itemRemovalCache.has(cacheKey)) return;
    itemRemovalCache.add(cacheKey);
    setTimeout(() => itemRemovalCache.delete(cacheKey), 300);


    const toRemove = actor.items.filter(i =>
        i.flags?.["upgradable-items"]?.sourceId === sourceItem.id &&
        i.flags?.["upgradable-items"]?.entryId === entryId
    );

    if (!toRemove.length) return;

    const idsToDelete = toRemove.map(i => i.id).filter(id => actor.items.get(id));
    if (!idsToDelete.length) return;

    try {
        await actor.deleteEmbeddedDocuments("Item", idsToDelete);
    } catch (err) {
        console.warn(`[Upgradable] Failed to remove item(s): ${idsToDelete.join(", ")}`, err);
    }
}

//async function removeItemFromActor(actor, compRef, sourceItem) {
//    const parts = compRef.split(".");
//    const packId = parts.slice(0, -1).join(".");
//    const entryId = parts.at(-1);

//    const toRemove = actor.items.filter(i =>
//        i.flags?.["upgradable-items"]?.sourceId === sourceItem.id &&
//        i.flags?.["upgradable-items"]?.entryId === entryId
//    );
//    if (toRemove.length) {
//        await actor.deleteEmbeddedDocuments("Item", toRemove.map(i => i.id));
//    }
//}

// Hooks //
Hooks.once("init", () => {
    loadTemplates(["modules/upgradable-items/templates/upitab-template.hbs"]);
    Handlebars.registerHelper("ifEquals", function (a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
    });
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
    const attunementRequired = Object.entries(attunementTypes).some(([key]) => key === "required" && key === attunement);;
    const wasAttuned = item.system.attuned;
    const willBeAttuned = changes.system?.attuned;

    const unequipped = wasEquipped && willBeEquipped === false;
    const unattuned = attunementRequired && wasAttuned && willBeAttuned === false;
    //const cluster2Changed = itemFlags.cluster2 === "2" && changes.flags?.["upgradable-items"]?.cluster2 !== "2";
    //const cluster3Changed = itemFlags.cluster3 === "3" && changes.flags?.["upgradable-items"]?.cluster3 !== "3";
    const oldCluster2 = item.getFlag("upgradable-items", "cluster2");
    const newCluster2 = changes.flags?.["upgradable-items"]?.cluster2;
    const cluster2Changed = oldCluster2 && oldCluster2 !== newCluster2;

    const oldCluster3 = item.getFlag("upgradable-items", "cluster3");
    const newCluster3 = changes.flags?.["upgradable-items"]?.cluster3;
    const cluster3Changed = oldCluster3 && oldCluster3 !== newCluster3;

    // Always remove Mobile if cluster2 changed
    if (cluster2Changed) {
        const mobileEntry = await findCompendiumItemByIdentifier("mobile");
        if (mobileEntry) await removeItemFromActor(actor, mobileEntry.id, item);
    }

    // Always remove Sharpshooter if cluster3 changed
    if (cluster3Changed) {
        const sharpshooterEntry = await findCompendiumItemByIdentifier("sharpshooter");
        if (sharpshooterEntry) await removeItemFromActor(actor, sharpshooterEntry.id, item);
    }

    // Handle unequip/unattune cleanup
    if (unequipped || unattuned) {
        if (itemFlags.selectedSpell) await removeItemFromActor(actor, itemFlags.selectedSpell, item);
        if (itemFlags.selectedFeat) await removeItemFromActor(actor, itemFlags.selectedFeat, item);
    }
});

// Hooks - Tier 1 & Tier 3 Armor Logic
Hooks.on("dnd5e.preApplyDamage", async (actor, damageData) => {
    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;

    const flags = armor.flags["upgradable-items"] ?? {};
    const { cluster1 = "0", enhanceLvl = "1" } = flags;
    const enhancementDie = getDieFormula(enhanceLvl);
    //const hp = actor.system.attributes.hp.value;
    //const maxHP = actor.system.attributes.hp.max;

    if (cluster1 === "1" && damageData.attackType === "melee" && isRuneReady(actor, "rune-reflected")) {
        await actor.setFlag("upgradable-items", "rune-reflected", true);
        const roll = await new Roll(enhancementDie).roll({ async: true });
        await damageData.source?.applyDamage?.(roll.total);
        ChatMessage.create({ speaker: { actor }, content: `Attacker was shocked for ${roll.total} lightning damage!` });
    }

    //if (cluster1 === "3" && hp < maxHP / 2) {
    //    const roll = await new Roll(enhancementDie).roll({ async: true });
    //    await actor.applyDamage(-roll.total);
    //    ChatMessage.create({ speaker: { actor }, content: `Rune armor pulsed, restored ${roll.total} HP!` });
    //}

    //if (cluster1 === "3" && hp <= 10 && damageData.attackType === "ranged") {
    //    const attacker = damageData.source;
    //    await attacker.setFlag("upgradable-items", "imposeDisadvantage", true);
    //    ChatMessage.create({ speaker: { actor }, content: `Rune aura flared, ranged attacker suffers disadvantage.` });
    //}

    // Cluster I Ranged Weapon: Apply disadvantage to target
    if (isRangedWeapon(damageData.item) && damageData.item.flags?.["upgradable-items"]?.cluster1 === "1") {
        const target = actor;
        const sourceItem = damageData.item;
        const sourceActor = damageData.source;

        applyTracerWhistleEffect(target, sourceActor, sourceItem);
    }

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

    // Cluster III Tier 2: Armor : First melee attack of round must make DC14 Con or lose bonus action for one round
    //TODO: Check This
    if (armor?.flags?.["upgradable-items"]?.cluster2 === "3" && damageData.attackType === "melee") {
        const alreadyTriggered = actor.getFlag("upgradable-items", "cluster3Used");
        if (alreadyTriggered) return;

        await actor.setFlag("upgradable-items", "cluster3Used", true);

        const attacker = damageData.source;
        if (!attacker) return;

        const save = await attacker.rollAbilitySave("con", {
            flavor: "Rune Armor Pulse (DC 14)",
            dc: 14
        });

        if (save.total < 14) {
            const bonusBlock = {
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

            await attacker.createEmbeddedDocuments("ActiveEffect", [bonusBlock]);

            ChatMessage.create({
                speaker: { actor: attacker },
                content: `${attacker.name} fails the save and loses their bonus action this round.`
            });
        }
    }

    // Cluster I Tier 3: Armor : On melee damage received, Allies within 10ft of wearer gain +2 to AC for 2 Rounds
    // TODO: Check This
    if (armor?.flags?.["upgradable-items"]?.cluster3 === "1" && damageData.attackType === "melee") {
        const originToken = actor.getActiveTokens()[0];
        if (!originToken) return;

        const nearbyAllies = canvas.tokens.placeables.filter(t =>
            t.actor?.id !== actor.id &&
            t.actor?.type === "character" &&
            canvas.grid.measureDistance(originToken, t) <= 10
        );

        for (const allyToken of nearbyAllies) {
            const allyActor = allyToken.actor;
            const existing = allyActor.effects.find(e =>
                e.label === "Rune Shield" &&
                e.origin === armor.uuid
            );
            if (existing) await allyActor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);

            const shieldEffect = {
                label: "Rune Shield",
                icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
                origin: armor.uuid,
                duration: { rounds: 2, startRound: game.combat?.round ?? 0 },
                changes: [{
                    key: "system.attributes.ac.bonus",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: "2",
                    priority: 20
                }],
                flags: {
                    "upgradable-items": {
                        sourceItem: armor.id
                    }
                }
            };

            await allyActor.createEmbeddedDocuments("ActiveEffect", [shieldEffect]);
        }

        ChatMessage.create({
            speaker: { actor },
            content: `Allies within 10 ft gain +2 AC for 2 rounds from the rune armor.`
        });
    }

    // Cluster II Tier 3: Armor : Wearer equal to or below 50% hp, gains resistance to all damage until the end of next round. Enemies within 10ft make Wis DC15 or become frightened
    // TODO: Check This
    if (armor?.getFlag("upgradable-items", "cluster2") === "3" && meetsUpgradableRequirements(armor)) {
        const hp = actor.system.attributes.hp.value;
        const maxHP = actor.system.attributes.hp.max;
        const used = actor.getFlag("upgradable-items", "cluster2Used");

        if (hp <= maxHP / 2 && !used) {
            await actor.setFlag("upgradable-items", "cluster2Used", true);

            const chatContent = `${actor.name}'s armor pulses with terrain memory, granting resistance and frightening nearby enemies.`;
            ChatMessage.create({ speaker: { actor }, content: chatContent });

            const resistanceEffect = {
                label: "Buried Watcher’s Mantle",
                icon: "icons/magic/defensive/shield-barrier-glow-blue.webp",
                origin: armor.uuid,
                duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                changes: [{
                    key: "system.traits.dr.all",
                    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                    value: "1",
                    priority: 20
                }],
                flags: { "upgradable-items": { sourceItem: armor.id } }
            };
            await actor.createEmbeddedDocuments("ActiveEffect", [resistanceEffect]);

            const originToken = actor.getActiveTokens()[0];
            const nearbyEnemies = canvas.tokens.placeables.filter(t =>
                t.actor?.type === "npc" &&
                t.document.disposition === -1 &&
                canvas.grid.measureDistance(originToken, t) <= 10
            );

            for (const token of nearbyEnemies) {
                const save = await token.actor.rollAbilitySave("wis", {
                    flavor: "Buried Watcher Fright Pulse (DC 15)",
                    dc: 15
                });

                if (save.total < 15) {
                    await token.actor.createEmbeddedDocuments("ActiveEffect", [{
                        label: "Frightened",
                        icon: "icons/magic/death/ghost-scream-teal.webp",
                        origin: armor.uuid,
                        duration: { rounds: 1, startRound: game.combat?.round ?? 0 },
                        flags: { core: { statusId: "Frightened" }, "upgradable-items": { sourceItem: armor.id } }
                    }]);
                }
            }
        }
    }
});

Hooks.on("dnd5e.preAttackRoll", async (actor, rollData) => {
    const hasDisadvantage = actor.getFlag("upgradable-items", "disadvantageAttack");
    if (hasDisadvantage) {
        rollData.disadvantage = true;
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
                await targetToken.document.update({ x: targetToken.x + dx, y: targetToken.y + dy });

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

    // Cluster I Tier 2: Ranged Weapon: Creates 10ft diameter area of light cover around shooter for self and allies
    if (isRangedWeapon(item) && cluster2 === "1" && meetsUpgradableRequirements(item)) {
        const shooterToken = canvas.tokens.get(msg.speaker.token);
        if (!shooterToken) return;

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

        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);

        ChatMessage.create({
            speaker: { actor },
            content: `Debris erupts around ${actor.name}, granting light cover to adjacent allies.`
        });
    }

    // Cluster II Tier 2 : Melee Weapon: Crit - Pull + Stagger
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
            await targetToken.document.update({ x: targetToken.x + dx, y: targetToken.y + dy });
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

    // Cluster I Tier 3: Ranged Weapon : Firing at Target or Empty space, create 15ft Diameter area that pulls all creatures 5ft closer to the center (no Overlap)
    if (isRangedWeapon(item) && cluster3 === "1" && meetsUpgradableRequirements(item)) {
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

                const newX = token.x - dx;
                const newY = token.y - dy;

                // Safeguard: prevent overlap or invalid movement
                const occupied = canvas.tokens.placeables.some(other =>
                    other.id !== token.id &&
                    Math.abs(other.x - newX) < canvas.grid.size &&
                    Math.abs(other.y - newY) < canvas.grid.size
                );

                if (!occupied) {
                    await token.document.update({ x: newX, y: newY });
                } else {
                    console.warn(`[Upgradable] Skipped movement for ${token.name} to avoid overlap.`);
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

    // Cluster II Tier 3: Melee Weapon : On Damage Roll, Target makes Dex 15 DC and restrained on failure. Also takes necrotic damage equal to enhancement die value
    if (isMeleeWeapon(item) && cluster2 === "3" && meetsUpgradableRequirements(item)) {
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
                description: `Spectral roots erupt from the terrain, restraining ${targetName}. At the start of their turn, they take necrotic damage equal to the rune’s enhancement die.`,
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
    if (isRangedWeapon(item) && cluster2 === "3" && meetsUpgradableRequirements(item)) {
        const center = targetToken?.center ?? canvas.mousePosition;
        const chatContent = targetActor
            ? `Sporewake cloud erupts around ${targetActor.name}, infecting terrain with poisonous spores.`
            : `Sporewake cloud erupts, infecting terrain with poisonous spores.`;

        ChatMessage.create({ speaker: { actor }, content: chatContent });

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
                    damageDie: getDieFormula(enhanceLvl)
                }
            }
        };
        let templatePlaced = false;

        if (targetToken) {
            await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            templatePlaced = true;
        } else {
            if (!templatePlaced) {

                ui.notifications.info("Click to place the Sporewake cloud.");
                const doc = new MeasuredTemplateDocument(templateData, { parent: canvas.scene });
                const template = new game.dnd5e.canvas.AbilityTemplate(doc);
                template.drawPreview();
                templatePlaced = true;
            };
        }
    }

    // Cluster III Tier 3: Melee Weapon : Create Phantom Illusion giving attacker advantage on next attack
    if (isMeleeWeapon(item) && cluster3 === "3" && meetsUpgradableRequirements(item)) {
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

Hooks.on("combatTurnStart", async (combat, turn, options) => {
    const actor = combat.combatant.actor;
    const token = actor?.getActiveTokens()[0];
    if (!token) return;

    const templates = canvas.templates.placeables.filter(t =>
        t.flags?.["upgradable-items"]?.clusterEffect === "sporewake"
    );

    for (const template of templates) {
        const distance = canvas.grid.measureDistance(token.center, template.center);
        if (distance <= template.document.distance) {
            await applySporewakeEffect(actor, template);
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
    await actor.unsetFlag("upgradable-items", "cluster2Used");
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
    await actor.unsetFlag("upgradable-items", "cluster2Used");
    await actor.unsetFlag("upgradable-items", "cluster3Used");
    await actor.unsetFlag("upgradable-items", "rune-reflected");
    await actor.unsetFlag("upgradable-items", "imposeDisadvantage");
});

Hooks.on("updateActor", async (actor, changes) => {
    upgradableAddCache.clear();
    upgradableRenderCache.clear();
    evaluationQueue.clear();
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
            showUpgrades
        });

        const injectedHtml = $(htmlload);

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

            // Update the flag first
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

            // Remove previous spell if one was selected
            if (prevValue) {
                await removeItemFromActor(actor, prevValue, app.object);
            }

            // Add new spell if one is selected and requirements are met
            if (newValue && meetsRequirements) {
                await addItemToActor(actor, newValue, app.object);
            }
        });

        // Handle feat selection
        injectedHtml.find('[name="flags.upgradable-items.selectedFeat"]').on("change", async (event) => {
            const newValue = event.target.value;
            const prevValue = itemFlags.selectedFeat;

            // Update the flag first
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

            // Remove previous spell if one was selected
            if (prevValue) {
                await removeItemFromActor(actor, prevValue, app.object);
            }

            // Add new spell if one is selected and requirements are met
            if (newValue && meetsRequirements) {
                await addItemToActor(actor, newValue, app.object);
            }
        });

        // Handle enhancement level changes
        injectedHtml.find('[name="flags.upgradable-items.enhanceLvl"]').on("change", async (event) => {
            const newValue = event.target.value;
            const prevValue = itemFlags.enhanceLvl ?? "0";

            // Update the flag first
            await app.object.setFlag("upgradable-items", "enhanceLvl", newValue);

            const actor = app.object.actor;
            if (!actor) return;

            // Re-evaluate item to update enhancement effect
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