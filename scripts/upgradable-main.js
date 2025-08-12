console.log('upgradable-items | Loading...');
const upgradableAddCache = new Set();


Hooks.once("init", () => {
    loadTemplates(["modules/upgradable-items/templates/upitab-template.hbs"]);
    Handlebars.registerHelper("ifEquals", function (a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
    });
});

// Utilities
function getEquippedRuneArmor(actor) {
    return actor.items.find(i =>
        i.type === "equipment" &&
        i.system.equipped &&
        i.system.armor &&
        i.flags["upgradable-items"]
    );
}

function getDieFormula(level) {
    return { "1": "1d4", "2": "1d6", "3": "1d8" }[level] ?? "1d4";
}

function isRuneReady(actor, key) {
    return !actor.flags["upgradable-items"]?.[key];
}

Hooks.on("preUpdateItem", async (item, changes) => {
    if (!["equipment", "weapon", "tool"].includes(item.type)) return;
    const actor = item.actor;
    if (!actor) return;

    const wasEquipped = item.system.equipped;
    const willBeEquipped = changes.system?.equipped;
    const attunementRequired = item.system.attunement === "required";
    const wasAttuned = item.system.attuned;
    const willBeAttuned = changes.system?.attuned;

    const unequipped = wasEquipped && willBeEquipped === false;
    const unattuned = attunementRequired && wasAttuned && willBeAttuned === false;

    if (unequipped || unattuned) {
        const itemFlags = foundry.utils.getProperty(item.flags, "upgradable-items") ?? {};
        if (itemFlags.selectedSpell) await removeItemFromActor(actor, itemFlags.selectedSpell, item);
        if (itemFlags.selectedFeat) await removeItemFromActor(actor, itemFlags.selectedFeat, item);
    }
});

// Tier 1 & Tier 3 Armor Logic
Hooks.on("dnd5e.preApplyDamage", async (actor, damageData) => {
    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;

    const flags = armor.flags["upgradable-items"] ?? {};
    const { cluster1 = "0", enhanceLvl = "1" } = flags;
    const enhancementDie = getDieFormula(enhanceLvl);
    const hp = actor.system.attributes.hp.value;
    const maxHP = actor.system.attributes.hp.max;

    if (cluster1 === "1" && damageData.attackType === "melee" && isRuneReady(actor, "rune-reflected")) {
        await actor.setFlag("upgradable-items", "rune-reflected", true);
        const roll = await new Roll(enhancementDie).roll({ async: true });
        await damageData.source?.applyDamage?.(roll.total);
        ChatMessage.create({ speaker: { actor }, content: `Attacker was shocked for ${roll.total} lightning damage!` });
    }

    if (cluster1 === "2" && actor.effects.some(e => e.statuses?.includes("prone"))) {
        const roll = await new Roll(enhancementDie).roll({ async: true });
        await actor.applyDamage(-roll.total);
        ChatMessage.create({ speaker: { actor }, content: `Rune armor restored ${roll.total} HP while prone.` });
    }

    if (cluster1 === "3" && hp < maxHP / 2) {
        const roll = await new Roll(enhancementDie).roll({ async: true });
        await actor.applyDamage(-roll.total);
        ChatMessage.create({ speaker: { actor }, content: `Rune armor pulsed — restored ${roll.total} HP!` });
    }

    if (cluster1 === "3" && hp <= 10 && damageData.attackType === "ranged") {
        const attacker = damageData.source;
        await attacker.setFlag("upgradable-items", "imposeDisadvantage", true);
        ChatMessage.create({ speaker: { actor }, content: `Rune aura flared — ranged attacker suffers disadvantage.` });
    }
});

// Cooldown Reset on Rest
Hooks.on("dnd5e.restCompleted", async (actor, restType) => {
    const armor = getEquippedRuneArmor(actor);
    if (!armor) return;
    await actor.unsetFlag("upgradable-items", "cluster2Used");
    await actor.unsetFlag("upgradable-items", "cluster3Used");
    await actor.unsetFlag("upgradable-items", "rune-reflected");
    await actor.unsetFlag("upgradable-items", "imposeDisadvantage");
});

// Weapon Enhancements
Hooks.on("dnd5e.rollDamage", async (item, config, damageRoll) => {
    if (!item?.actor) return;

    const runeData = item.flags["upgradable-items"] ?? {};
    const { enhanceLvl = "0", cluster1 = "0" } = runeData;
    const itemType = item.type;
    const weaponSubtype = item.system.weaponType ?? "";
    const attunementTypes = CONFIG.DND5E.attunementTypes;
    const attunement = item.system.attunement ?? "";
    const isEquipped = item.system.equipped ?? true;
    const isAttuned = item.system.attuned ?? false;
    const requiresAttunement = Object.entries(attunementTypes).some(([key]) => key === "required" && key === attunement);

    if (itemType !== "weapon" || !isEquipped || (requiresAttunement && !isAttuned)) {
        console.log(`[Item Upgrades] Skipping enhancements for ${item.name} — not equipped or attuned.`);
        return;
    }

    const isRangedWeapon = weaponSubtype.includes("R");
    if (isRangedWeapon) {
        await applyRangedEnhancements(item.actor, item, runeData);
    } else {
        await applyMeleeEnhancements(item.actor, item, runeData);
    }
});

async function applyRangedEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster = upgrades.cluster1;
    if (level == 0) return;

    const damageDieMap = { "1": "1d4", "2": "1d6", "3": "1d8" };
    const clusterDamageTypeMap = { "1": "fire", "2": "acid", "3": "cold" };
    const damageDie = damageDieMap[level] ?? "1d4";
    const damageType = clusterDamageTypeMap[cluster] ?? "force";

    const roll = new Roll(`${damageDie}`);
    await roll.evaluate({ async: true });
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes a ${damageType} burst from its enhancement!`,
        rollMode: game.settings.get("core", "rollMode")
    });
}

async function applyMeleeEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster = upgrades.cluster1;
    if (level == 0) return;

    const damageDieMap = { "1": "1d4", "2": "1d6", "3": "1d8" };
    const clusterDamageTypeMap = { "1": "fire", "2": "acid", "3": "cold" };
    const damageDie = damageDieMap[level] ?? "1d4";
    const damageType = clusterDamageTypeMap[cluster] ?? "force";

    const roll = new Roll(`${damageDie}`);
    await roll.evaluate({ async: true });
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes a ${damageType} burst from its enhancement!`,
        rollMode: game.settings.get("core", "rollMode")
    });
}

Hooks.on("updateActor", () => {
    upgradableAddCache.clear();
});


// Sheet Injection
Hooks.on("renderItemSheet5e", async (app, html, data) => {
    try {
        const locale = game.i18n.translations[game.i18n.lang]?.["upgradable-items"]?.SOLVARIS?.Labels || {};
        const enhanceLvlObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["EnhancementLevels"] ?? {};
        const enhanceLvls = Object.entries(enhanceLvlObj).map(([id, label]) => ({ id, label }));
        const clusterObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["Cluster"] ?? {};
        const runeClusters = Object.entries(clusterObj).map(([id, label]) => ({ id, label }));
        const itemFlags = foundry.utils.getProperty(app.object, "flags.upgradable-items") || {};

        const getCompendiumItems = async (type) => {
            const packs = game.packs.filter(p => p.documentName === "Item");
            const entries = [];

            for (const pack of packs) {
                const index = await pack.getIndex();
                for (const entry of index) {
                    if (entry.type === type) {
                        entries.push({
                            id: entry._id,
                            label: `${pack.metadata.label}: ${entry.name}`,
                            pack: pack.metadata.id
                        });
                    }
                }
            }

            return entries.sort((a, b) => a.label.localeCompare(b.label));
        };

        const spells = await getCompendiumItems("spell");
        const feats = await getCompendiumItems("feat");
        const selectedSpell = itemFlags.selectedSpell ?? "";
        const selectedFeat = itemFlags.selectedFeat ?? "";

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
            selectedFeat
        });

        const injectedHtml = $(htmlload);

        // Handle rune cluster changes
        injectedHtml.find('[data-property]').on("change", async (event) => {
            const key = event.currentTarget.dataset.property;
            const selectedId = event.currentTarget.value;

            try {
                await app.object.setFlag("upgradable-items", key, selectedId);
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

        // Inject into sheet
        target.after(injectedHtml);
    } catch (error) {
        console.error("Upitab Injection Error:", error);
    }
});

Hooks.on("updateItem", async (item, changes) => {
    if (!item.flags?.["upgradable-items"]) return;
    const actor = item.actor;
    if (!actor) return;

    //const attunementTypes = CONFIG.DND5E.attunementTypes;
    //const attunement = changes.system?.attunement ?? item.system.attunement;
    //const isEquipped = changes.system?.equipped ?? item.system.equipped;
    //const isAttuned = attunement === attunementTypes.REQUIRED;
    ////////////////////
    const itemType = item.type;
    const weaponSubtype = item.system.weaponType ?? "";
    const attunementTypes = CONFIG.DND5E.attunementTypes;
    const attunement = item.system.attunement ?? "";
    const isEquipped = item.system.equipped ?? true;
    const isAttuned = item.system.attuned ?? false;
    const requiresAttunement = Object.entries(attunementTypes).some(([key]) => key === "required" && key === attunement);

    if (!isEquipped || (requiresAttunement && !isAttuned)) {
        console.log(`[Item Upgrades] Skipping enhancements for ${item.name} — not equipped or attuned.`);
        return;
    }
    ////////////////////

    //const requiresAttunement = item.flags["upgradable-items"].requiresAttunement ?? false;

    // Require equipped always, and attunement only if item demands it
    //const meetsRequirements = isEquipped && (!requiresAttunement || isAttuned);
    //if (!meetsRequirements) return;

    const selectedSpell = item.getFlag("upgradable-items", "selectedSpell");
    const selectedFeat = item.getFlag("upgradable-items", "selectedFeat");

    if (selectedSpell) await addItemToActor(actor, selectedSpell, item);
    if (selectedFeat) await addItemToActor(actor, selectedFeat, item);
});


// Add item to actor from compendium
async function addItemToActor(actor, compRef, sourceItem) {
    const [packId, entryId] = compRef.split(/(?<=\..+)\.(?=[^\.]+$)/);
    const pack = game.packs.get(packId);
    if (!pack) {
        console.warn(`[Upgradable] Pack not found: ${packId}`);
        return;
    }

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
        console.log(`[Upgradable] Skipping duplicate: ${entry.name}`);
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

// Remove item from actor
async function removeItemFromActor(actor, compRef, sourceItem) {
    const parts = compRef.split(".");
    const packId = parts.slice(0, -1).join(".");
    const entryId = parts.at(-1);

    const toRemove = actor.items.filter(i =>
        i.flags?.["upgradable-items"]?.sourceId === sourceItem.id &&
        i.flags?.["upgradable-items"]?.entryId === entryId
    );

    if (toRemove.length) {
        await actor.deleteEmbeddedDocuments("Item", toRemove.map(i => i.id));
    }

}

console.log('upgradable-items | Loading Complete');