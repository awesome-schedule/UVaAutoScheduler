/**
 * The Store module provides methods to save, retrieve and manipulate store.
 * It gathers all children modules and store their references in a single store class,
 * which is provided as a Mixin
 * @module store
 * @preferred
 */

/**
 *
 */
import Vue from 'vue';
import { Component, Watch } from 'vue-property-decorator';
import { EvaluatorOptions } from '../algorithm/ScheduleEvaluator';
import ScheduleGenerator, { GeneratorOptions } from '../algorithm/ScheduleGenerator';
import { SemesterJSON } from '../models/Catalog';
import { CourseStatus } from '../models/Meta';
import Schedule, { ScheduleJSON } from '../models/Schedule';
import display, { DisplayState } from './display';
import filter, { FilterStateJSON } from './filter';
import modal from './modal';
import noti from './notification';
import palette, { PaletteState } from './palette';
import profile from './profile';
import schedule, { ScheduleStateJSON } from './schedule';
import semester, { SemesterState } from './semester';
import status from './status';
import Expirable from '@/data/Expirable';
import param from '../config';

export interface SemesterStorage extends Expirable {
    name: string;
    currentSemester: SemesterJSON;
    display: DisplayState;
    filter: FilterStateJSON;
    schedule: ScheduleStateJSON;
    palette: PaletteState;
}

interface LegacyScheduleJSON extends ScheduleJSON {
    savedColors: { [x: string]: string };
}

/**
 * the storage format prior to v4.5
 */
export interface LegacyStorage {
    currentSemester: SemesterJSON;
    currentScheduleIndex: number;
    proposedScheduleIndex: number;
    cpIndex: number;
    currentSchedule: LegacyScheduleJSON;
    proposedSchedules: LegacyScheduleJSON[];

    display: DisplayState;

    timeSlots: [boolean, boolean, boolean, boolean, boolean, string, string][];
    allowWaitlist: boolean;
    allowClosed: boolean;
    sortOptions: EvaluatorOptions;
}

/**
 * the storage format prior to v3.0
 */
export interface AncientStorage extends DisplayState {
    currentSemester: SemesterJSON;
    currentScheduleIndex: number;
    currentSchedule: LegacyScheduleJSON;
    proposedSchedule: LegacyScheduleJSON;

    timeSlots: [boolean, boolean, boolean, boolean, boolean, string, string][];
    allowWaitlist: boolean;
    allowClosed: boolean;
    sortOptions: EvaluatorOptions;
}

interface StorageItem<State, JSONState> {
    /**
     * a method to obtain the default state
     */
    getDefault(): State;
    /**
     * serialize `this` (the store module) to its JSON representation
     */
    toJSON(this: StoreModule<State, JSONState>): JSONState;
    /**
     * recover the state from its JSON representation
     *
     * An object that has all or some properties of the `JSONState` will be passed as a parameter.
     * The missing properties will be assigned with the value returned by the `getDefault` method.
     */
    fromJSON(obj: Partial<JSONState>): void;
}

/**
 * A Store Module must have
 * @typeparam State
 * @typeparam JSONState the JSON representation of its state
 *
 * and the three methods defined by [[StorageItem]]
 */
export type StoreModule<State, JSONState> = State & StorageItem<State, JSONState>;

function isAncient(parsed: any): parsed is AncientStorage {
    return !!parsed.currentSchedule && !!parsed.proposedSchedule;
}

function isLegacy(parsed: any): parsed is LegacyStorage {
    return !!parsed.currentSchedule && !!parsed.proposedSchedules;
}

export function saveStatus() {
    const { currentSemester } = semester;
    if (!currentSemester) return;
    const name = profile.current;

    const obj: SemesterStorage = {
        name,
        modified: new Date().toJSON(),
        currentSemester,
        display,
        filter,
        schedule: schedule.toJSON(),
        palette
    };

    localStorage.setItem(name, JSON.stringify(obj));
    console.log('status saved');
}

const compare: { schedule: Schedule; profileName: string; semester: string; color: string }[] = [];
/**
 * The Store module provides methods to save, retrieve and manipulate store.
 * It gathers all children modules and store their references in a single store class, which is provided as a Mixin
 */
@Component
class Store extends Vue {
    filter = filter;
    display = display;
    status = status;
    modal = modal;
    schedule = schedule;
    semester = semester;
    palette = palette;
    noti = noti;
    profile = profile;
    compare = compare;

    /**
     * save all store modules to localStorage
     */
    saveStatus() {
        saveStatus();
    }

    /**
     * given the profile name, switch to the profile's semester.
     * recover all store modules' states from the localStorage,
     * and assign a correct Catalog object to `window.catalog`,
     * @param name
     */
    async loadProfile(name?: string, force = false) {
        if (!this.semester.semesters.length) {
            this.noti.error('No semester data! Please refresh this page');
            return;
        }
        if (!name) name = this.profile.current;

        window.scheduleEvaluator.clear();
        let parsed: Partial<AncientStorage> | Partial<LegacyStorage> | Partial<SemesterState> = {};
        const data = localStorage.getItem(name);
        if (data) {
            try {
                parsed = JSON.parse(data);
            } catch (e) {
                console.error(e);
            }
        }
        const msg = await this.semester.selectSemester(
            parsed.currentSemester || this.semester.semesters[0],
            force
        );
        this.noti.notify(msg);
        if (!msg.payload) return;

        if (isAncient(parsed)) {
            const ancient: AncientStorage = parsed || {};
            const oldStore: Partial<LegacyStorage> & AncientStorage = ancient;
            oldStore.proposedScheduleIndex = 0;
            oldStore.proposedSchedules = [oldStore.proposedSchedule];
            this.display.fromJSON(oldStore);
            this.filter.fromJSON(oldStore);
            this.schedule.fromJSON(oldStore);
            this.palette.fromJSON(oldStore.currentSchedule || { savedColors: {} });
        } else if (isLegacy(parsed)) {
            this.display.fromJSON(parsed.display || {});
            this.filter.fromJSON(parsed);
            this.schedule.fromJSON(parsed);
            this.palette.fromJSON(parsed.currentSchedule || { savedColors: {} });
        } else {
            const newStore = parsed as SemesterStorage;
            this.display.fromJSON(newStore.display || {});
            this.filter.fromJSON(newStore.filter || {});
            this.schedule.fromJSON(newStore.schedule || {});
            this.palette.fromJSON(newStore.palette || {});
        }
        if (this.schedule.generated) this.generateSchedules();
        else this.schedule.switchSchedule(false);
    }

    /**
     * @returns true if the current combination of sort options is valid, false otherwise
     */
    validateSortOptions() {
        if (!Object.values(this.filter.sortOptions.sortBy).some(x => x.enabled)) {
            this.noti.error('You must have at least one sort option!');
            return false;
        } else if (
            Object.values(this.filter.sortOptions.sortBy).some(
                x => x.name === 'distance' && x.enabled
            ) &&
            (!window.buildingList || !window.timeMatrix)
        ) {
            this.noti.error('Building list fails to load. Please disable "walking distance"');
            return false;
        }
        return true;
    }

    getGeneratorOptions(): GeneratorOptions | void {
        const filteredStatus: CourseStatus[] = [];
        if (!this.filter.allowWaitlist) filteredStatus.push('Wait List');
        if (!this.filter.allowClosed) filteredStatus.push('Closed');

        const msg = this.filter.computeFilter();
        const timeSlots = msg.payload;
        if (!timeSlots) return this.noti.notify(msg);

        if (!this.validateSortOptions()) return;

        return {
            timeSlots,
            status: filteredStatus,
            sortOptions: this.filter.sortOptions,
            combineSections: this.display.combineSections,
            maxNumSchedules: this.display.maxNumSchedules
        };
    }

    generateSchedules() {
        this.status.foldView();

        if (this.schedule.proposedSchedule.empty())
            return this.noti.warn(`There are no classes in your schedule!`);

        const options = this.getGeneratorOptions();
        if (!options) return;

        const generator = new ScheduleGenerator(window.catalog, window.buildingList, options);
        const msg = generator.getSchedules(this.schedule.proposedSchedule);
        this.noti.notify(msg);
        const evaluator = msg.payload;
        if (evaluator) {
            window.scheduleEvaluator = evaluator;
            this.schedule.numGenerated = evaluator.size();
            this.schedule.cpIndex = this.schedule.proposedScheduleIndex;
            this.schedule.switchSchedule(true);
        } else {
            window.scheduleEvaluator.clear();
            this.schedule.switchSchedule(false);
            this.schedule.cpIndex = -1;
            this.schedule.numGenerated = 0;
        }
    }

    /**
     * Select a semester and fetch all its associated data,
     * note that the first profile corresponding to the target semester will be loaded.
     *
     * @param target the semester to switch to
     * @param force whether to force-update semester data
     */
    async selectSemester(target?: SemesterJSON, force = false) {
        if (!this.semester.semesters.length) {
            this.noti.error('No semester data! Please refresh this page');
            return;
        }
        if (!target) target = this.semester.semesters[0];
        if (force) {
            this.noti.info(`Updating ${target.name} data...`);
            await this.loadProfile(this.profile.current, force);
            return;
        } else if (this.semester.currentSemester && target.id === this.semester.currentSemester.id)
            return;

        this.status.loading = true;

        const { profiles } = this.profile;
        let parsed: Partial<SemesterStorage> = {};
        let parsedLatest = -Infinity;
        for (const profileName of profiles) {
            const data = localStorage.getItem(profileName);
            if (data) {
                const temp: Partial<SemesterStorage> = JSON.parse(data);
                const { currentSemester, modified } = temp;
                if (currentSemester && currentSemester.id === target.id) {
                    if (modified) {
                        const time = new Date(modified).getTime();
                        if (time > parsedLatest) {
                            parsed = temp;
                            parsedLatest = time;
                        }
                    } else {
                        if (!parsed.currentSemester) parsed = temp;
                    }
                    break;
                }
            }
        }
        // no profile for target semester exists. let's create one
        if (!parsed.currentSemester) {
            let { name } = target;
            if (profiles.includes(name)) {
                if (
                    !confirm(
                        // tslint:disable-next-line: max-line-length
                        `You already have a profile named ${name}. However, it does not correspond to the ${name} semester. Click Ok to overwrite, click Cancel to keep both.`
                    )
                ) {
                    name += ' (2)';
                    profiles.push(name);
                }
            } else {
                profiles.push(name);
            }
            parsed.currentSemester = target;
            this.profile.current = parsed.name = name;
            localStorage.setItem(name, JSON.stringify(parsed));
        } else {
            this.profile.current = parsed.name!;
        }
        await this.loadProfile();
        this.status.loading = false;
    }
}

/**
 * the watch factory defines some watchers on the members in `Store`.
 * these watchers are defined outside of the `Store` class because they should only be registered once.
 */
@Component
// tslint:disable-next-line: max-classes-per-file
class WatchFactory extends Store {
    @Watch('status.loading')
    loadingWatch() {
        if (this.status.loading) {
            if (this.noti.empty()) {
                this.noti.info('Loading...');
            }
        } else {
            if (this.noti.msg === 'Loading...') {
                this.noti.clear();
            }
        }
    }

    @Watch('display.multiSelect')
    private w0() {
        Schedule.options.multiSelect = this.display.multiSelect;
        this.schedule.currentSchedule.computeSchedule();
    }

    @Watch('display.combineSections')
    private a() {
        Schedule.options.combineSections = this.display.combineSections;
        this.schedule.currentSchedule.computeSchedule();
    }

    @Watch('palette.savedColors', { deep: true })
    private b() {
        Schedule.savedColors = this.palette.savedColors;
        this.schedule.currentSchedule.computeSchedule();
    }

    @Watch('profile.current')
    private c() {
        localStorage.setItem('currentProfile', this.profile.current);
    }

    @Watch('profile.profiles', { deep: true })
    private d() {
        localStorage.setItem('profiles', JSON.stringify(this.profile.profiles));
    }

    // @Watch('schedule', { deep: true })
    // private w1() {
    //     this.saveStatus();
    // }

    @Watch('display', { deep: true })
    private w2() {
        this.saveStatus();
    }

    @Watch('filter', { deep: true })
    private w3() {
        this.saveStatus();
    }

    @Watch('palette', { deep: true })
    private w4() {
        this.saveStatus();
    }
}

declare global {
    interface Window {
        watchers: WatchFactory;
    }
}
window.watchers = new WatchFactory();
export default Store;
